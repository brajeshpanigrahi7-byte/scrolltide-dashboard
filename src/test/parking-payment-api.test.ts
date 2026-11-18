// @vitest-environment node
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { razorpayWebhook } from "@/lib/parking/payment-api.server";

const state = vi.hoisted(() => ({ calls: 0, result: "captured" as string }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    rpc: async () => { state.calls++; return { data: state.result, error: null }; },
    from: () => { throw new Error("Unexpected table access"); },
  },
}));

function webhook(raw: string, signed = true) {
  return new Request("https://parksense.example/api/public/razorpay-webhook", {
    method: "POST", body: raw,
    headers: signed ? { "X-Razorpay-Signature": createHmac("sha256", "test-webhook-only").update(raw).digest("hex") } : {},
  });
}

beforeEach(() => { vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", "test-webhook-only"); state.calls = 0; state.result = "captured"; });
afterEach(() => { vi.unstubAllEnvs(); });

describe("Razorpay webhook", () => {
  it("rejects unsigned and tampered payloads before payment writes", async () => {
    const raw = JSON.stringify({ event: "payment.captured" });
    expect((await razorpayWebhook(webhook(raw, false))).status).toBe(400);
    const signed = webhook(raw);
    const altered = new Request(signed.url, { method: "POST", headers: signed.headers, body: `${raw} ` });
    expect((await razorpayWebhook(altered)).status).toBe(400);
    expect(state.calls).toBe(0);
  });
  it("rejects signed malformed JSON", async () => {
    expect((await razorpayWebhook(webhook("{"))).status).toBe(400);
    expect(state.calls).toBe(0);
  });
  it("maps captured payments to the shared atomic confirmation", async () => {
    const raw = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: {
      id: "pay_fixture", order_id: "order_fixture", amount: 1000,
    } } } });
    const response = await razorpayWebhook(webhook(raw));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, result: "captured" });
    expect(state.calls).toBe(1);
  });
  it("acknowledges late payments flagged for manual refund", async () => {
    state.result = "needs_refund";
    const raw = JSON.stringify({ event: "order.paid", payload: { order: { entity: {
      id: "order_fixture", amount_paid: 1000,
    } } } });
    expect((await razorpayWebhook(webhook(raw))).status).toBe(200);
  });
});

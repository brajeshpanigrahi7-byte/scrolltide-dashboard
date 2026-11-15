// @vitest-environment node
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession, razorpayWebhook, sessionStatus } from "@/lib/parking/payment-api.server";

const state = vi.hoisted(() => ({
  session: { id: "ed449674-9b29-4ccb-9139-dcfe6289a125", slot: 3, amount_inr: 40, status: "pending", created_at: "2026-11-15T05:00:00Z", paid_at: null as string | null, payment_link_id: "plink_fixture", short_url: "https://rzp.io/i/fixture" },
  writes: [] as Record<string, unknown>[],
  calls: 0,
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => {
      state.calls++;
      let changes: Record<string, unknown> | undefined;
      const builder = {
        insert: (value: Record<string, unknown>) => { state.writes.push(value); return builder; },
        select: () => builder,
        single: async () => ({ data: { ...state.session }, error: null }),
        update: (value: Record<string, unknown>) => { changes = value; return builder; },
        eq: () => builder,
        in: (_key: string, allowed: string[]) => {
          if (allowed.includes(state.session.status) && changes) { state.writes.push(changes); Object.assign(state.session, changes); }
          return Promise.resolve({ error: null });
        },
        then: (resolve: (result: { error: null }) => unknown) => {
          if (changes) { state.writes.push(changes); Object.assign(state.session, changes); }
          return Promise.resolve(resolve({ error: null }));
        },
      };
      return builder;
    },
    rpc: async () => {
      const status = state.session.status;
      if (status === "paid") state.session.status = "used";
      return { data: status, error: null };
    },
  },
}));
const request = (path: string, body?: unknown, authorized = true) => new Request(`https://parksense.example/api/public/${path}`, {
  method: body === undefined ? "GET" : "POST",
  headers: { ...(authorized ? { "x-device-key": "test-device-only" } : {}), "Content-Type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const paidEvent = () => ({ event: "payment_link.paid", payload: { payment_link: { entity: {
  id: "plink_fixture", reference_id: state.session.id, status: "paid", amount: 4000, amount_paid: 4000, currency: "INR",
} } } });
const webhook = (raw: string, signed = true) => new Request("https://parksense.example/api/public/razorpay-webhook", {
  method: "POST", body: raw, headers: signed ? { "X-Razorpay-Signature": createHmac("sha256", "test-webhook-only").update(raw).digest("hex") } : {},
});

beforeEach(() => {
  vi.stubEnv("DEVICE_API_KEY", "test-device-only");
  vi.stubEnv("RAZORPAY_KEY_ID", "test-key-only");
  vi.stubEnv("RAZORPAY_KEY_SECRET", "test-provider-only");
  vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", "test-webhook-only");
  state.session.status = "pending"; state.session.paid_at = null; state.writes = []; state.calls = 0;
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("secure device payment endpoints", () => {
  it("rejects unauthenticated creation and polling without touching records", async () => {
    expect((await createSession(request("create-session", { slot: 3, amount_inr: 40 }, false))).status).toBe(401);
    expect((await sessionStatus(request(`session-status?id=${state.session.id}`, undefined, false))).status).toBe(401);
    expect(state.calls).toBe(0);
  });
  it("creates a pending session and Razorpay INR link expiring in fifteen minutes", async () => {
    let payload: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      payload = JSON.parse(String(init.body));
      return Response.json({ id: "plink_fixture", short_url: "https://rzp.io/i/fixture" });
    });
    const response = await createSession(request("create-session", { slot: 3, amount_inr: 40 }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ session_id: state.session.id, short_url: "https://rzp.io/i/fixture" });
    expect(payload).toMatchObject({ amount: 4000, currency: "INR", reference_id: state.session.id, description: "Parking slot 3", expire_by: Date.parse(state.session.created_at) / 1000 + 900 });
    expect(state.writes[0]).toEqual({ slot: 3, amount_inr: 40 });
    expect(state.writes[1]).toEqual({ payment_link_id: "plink_fixture", short_url: "https://rzp.io/i/fixture" });
  });
  it("rejects amounts outside the tariff before creating a record", async () => {
    expect((await createSession(request("create-session", { slot: 3, amount_inr: 25 }))).status).toBe(400);
    expect(state.calls).toBe(0);
  });
  it("expires a rejected payment-link creation without exposing provider details", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", async () => Response.json({ private_account_details: "must-not-be-returned" }, { status: 400 }));
    const response = await createSession(request("create-session", { slot: 3, amount_inr: 40 }));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Razorpay could not create the payment link" });
    expect(state.session.status).toBe("expired");
  });
  it("returns paid once and used on subsequent device polls", async () => {
    state.session.status = "paid";
    expect(await (await sessionStatus(request(`session-status?id=${state.session.id}`))).json()).toEqual({ status: "paid" });
    expect(await (await sessionStatus(request(`session-status?id=${state.session.id}`))).json()).toEqual({ status: "used" });
  });
});

describe("Razorpay webhook", () => {
  it("rejects unsigned and tampered raw payloads before reading any records", async () => {
    const raw = JSON.stringify(paidEvent());
    expect((await razorpayWebhook(webhook(raw, false))).status).toBe(401);
    const signed = webhook(raw);
    const altered = new Request(signed.url, { method: "POST", headers: signed.headers, body: `${raw} ` });
    expect((await razorpayWebhook(altered)).status).toBe(401);
    expect(state.calls).toBe(0);
  });
  it("rejects signed malformed JSON with a controlled error", async () => {
    expect((await razorpayWebhook(webhook("{"))).status).toBe(400);
    expect(state.calls).toBe(0);
  });
  it("does not authorize a mismatched amount", async () => {
    const event = paidEvent(); event.payload.payment_link.entity.amount_paid = 20;
    expect((await razorpayWebhook(webhook(JSON.stringify(event)))).status).toBe(400);
    expect(state.session.status).toBe("pending");
  });
  it("confirms payment idempotently and never reauthorizes a used session", async () => {
    const raw = JSON.stringify(paidEvent());
    expect((await razorpayWebhook(webhook(raw))).status).toBe(200);
    expect(state.session.status).toBe("paid");
    const paidAt = state.session.paid_at;
    expect(paidAt).not.toBeNull();
    await razorpayWebhook(webhook(raw));
    expect(state.writes).toHaveLength(1);
    expect(state.session.paid_at).toBe(paidAt);
    state.session.status = "used";
    await razorpayWebhook(webhook(raw));
    expect(state.session.status).toBe("used");
    expect(state.writes).toHaveLength(1);
  });
});
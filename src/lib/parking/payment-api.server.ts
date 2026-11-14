import { z } from "zod";
import { createSessionSchema, sessionIdSchema } from "./payments";
import { sameSecret, validWebhook } from "./payment-security.server";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const webhookSchema = z.object({ event: z.string(), payload: z.object({ payment_link: z.object({ entity: z.object({ id: z.string(), reference_id: sessionIdSchema, status: z.string(), amount: z.number().int(), amount_paid: z.number().int(), currency: z.string() }) }) }) });

export async function createSession(request: Request) {
  if (!sameSecret(request.headers.get("x-device-key"), process.env['DEVICE_API_KEY'])) return json({ error: "Unauthorized" }, 401);
  const keyId = process.env['RAZORPAY_KEY_ID']; const keySecret = process.env['RAZORPAY_KEY_SECRET'];
  if (!keyId || !keySecret) return json({ error: "Razorpay is not configured" }, 503);
  const parsed = createSessionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: "Slot must be 1–5 and amount ₹20–₹200 in ₹20 steps" }, 400);
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: session, error } = await supabaseAdmin.from("parking_sessions").insert(parsed.data).select().single();
  if (error || !session) return json({ error: "Could not create session" }, 500);
  try {
    const response = await fetch("https://api.razorpay.com/v1/payment_links", {
      method: "POST", headers: { Authorization: `Basic ${btoa(`${keyId}:${keySecret}`)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ amount: session.amount_inr * 100, currency: "INR", reference_id: session.id, description: `Parking slot ${session.slot}`, expire_by: Math.floor(Date.parse(session.created_at) / 1000) + 900, accept_partial: false }),
    });
    if (!response.ok) {
      const detail = await response.text(); console.error("Razorpay create-link failed", response.status, detail);
      await supabaseAdmin.from("parking_sessions").update({ status: "expired" }).eq("id", session.id);
      return json({ error: "Razorpay could not create the payment link", provider_status: response.status, detail }, 502);
    }
    const link = z.object({ id: z.string().startsWith("plink_"), short_url: z.string().url() }).parse(await response.json());
    if (!link.short_url.startsWith("https://")) throw new Error("Invalid payment URL");
    const saved = await supabaseAdmin.from("parking_sessions").update({ payment_link_id: link.id, short_url: link.short_url }).eq("id", session.id);
    if (saved.error) throw new Error("Payment link could not be saved");
    return json({ session_id: session.id, short_url: link.short_url });
  } catch (error) {
    console.error("Parking payment creation failed", error instanceof Error ? error.message : "Unknown error");
    return json({ error: "Payment creation interrupted; check the session before retrying", session_id: session.id }, 502);
  }
}

export async function razorpayWebhook(request: Request) {
  const raw = await request.text();
  if (!process.env['RAZORPAY_WEBHOOK_SECRET']) return json({ error: "Webhook is not configured" }, 503);
  if (!validWebhook(raw, request.headers.get("x-razorpay-signature"), process.env['RAZORPAY_WEBHOOK_SECRET'])) return json({ error: "Invalid signature" }, 401);
  const body = JSON.parse(raw);
  if (body.event !== "payment_link.paid") return json({ received: true });
  const parsed = webhookSchema.safeParse(body);
  if (!parsed.success) return json({ error: "Invalid payment event" }, 400);
  const link = parsed.data.payload.payment_link.entity;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: session, error } = await supabaseAdmin.from("parking_sessions").select().eq("id", link.reference_id).single();
  if (error || !session) return json({ error: "Unknown session" }, 404);
  if (link.id !== session.payment_link_id || link.status !== "paid" || link.currency !== "INR" || link.amount !== session.amount_inr * 100 || link.amount_paid !== session.amount_inr * 100) return json({ error: "Payment does not match session" }, 400);
  // Conditional update preserves used sessions and the first paid_at on webhook retries.
  const result = await supabaseAdmin.from("parking_sessions").update({ status: "paid", paid_at: new Date().toISOString() }).eq("id", session.id).in("status", ["pending", "expired"]);
  if (result.error) return json({ error: "Payment confirmation could not be saved" }, 500);
  return json({ received: true });
}

export async function sessionStatus(request: Request) {
  if (!sameSecret(request.headers.get("x-device-key"), process.env['DEVICE_API_KEY'])) return json({ error: "Unauthorized" }, 401);
  const parsed = sessionIdSchema.safeParse(new URL(request.url).searchParams.get("id"));
  if (!parsed.success) return json({ error: "Invalid session ID" }, 400);
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin.rpc("consume_parking_session", { p_id: parsed.data });
  if (error) return json({ error: "Could not read session" }, 500);
  if (!data) return json({ error: "Unknown session" }, 404);
  return json({ status: data });
}
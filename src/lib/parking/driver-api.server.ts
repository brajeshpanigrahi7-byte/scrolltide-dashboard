import { z } from "zod";
import { pricePaise } from "./payments";
import { requestFingerprint, validCheckoutSignature } from "./payment-security.server";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Cache-Control": "no-store",
};
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });
export const publicOptions = () => new Response(null, { status: 204, headers: cors });

async function rateLimit(request: Request, scope: string, limit: number): Promise<Response | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin.rpc("check_rate_limit", {
    p_key: requestFingerprint(request, scope), p_limit: limit, p_window_seconds: 60,
  });
  if (error) return json({ error: "Rate limit unavailable" }, 503);
  return data ? null : json({ error: "Too many requests" }, 429);
}

async function razorpayFetch(path: string, init: RequestInit = {}) {
  const keyId = process.env["RAZORPAY_KEY_ID"];
  const keySecret = process.env["RAZORPAY_KEY_SECRET"];
  if (!keyId || !keySecret) throw new Error("Razorpay is not configured");
  return fetch(`https://api.razorpay.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Basic ${btoa(`${keyId}:${keySecret}`)}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
    signal: AbortSignal.timeout(15000),
  });
}

const codeSchema = z.string().regex(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);

export async function sessionPublic(request: Request) {
  const limited = await rateLimit(request, "session-public", 120);
  if (limited) return limited;
  const parsed = codeSchema.safeParse(new URL(request.url).searchParams.get("code")?.toUpperCase());
  if (!parsed.success) return json({ error: "Invalid code" }, 400);
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const [{ data: session }, { data: settings }] = await Promise.all([
    supabaseAdmin.from("sessions").select("*").eq("code", parsed.data).maybeSingle(),
    supabaseAdmin.from("settings").select("*").eq("id", true).single(),
  ]);
  if (!session) return json({ error: "Session not found" }, 404);
  if (session.status === "pending" && Date.now() >= Date.parse(session.expires_at)) {
    await supabaseAdmin.from("sessions").update({ status: "expired" }).eq("id", session.id).eq("status", "pending");
    session.status = "expired";
  }
  const { data: receipt } = await supabaseAdmin.from("payments")
    .select("razorpay_payment_id").eq("session_id", session.id).eq("status", "captured")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  const now = Date.now();
  return json({
    status: session.status,
    slot: session.slot,
    duration_min: session.duration_min,
    seconds_remaining: session.end_time ? Math.max(0, Math.floor((Date.parse(session.end_time) - now) / 1000)) : 0,
    amount: session.amount_paise,
    expires_in: session.status === "pending" ? Math.max(0, Math.floor((Date.parse(session.expires_at) - now) / 1000)) : 0,
    price_options: (settings?.duration_options ?? [30, 60, 120, 180, 240]).map((duration_min) => ({
      duration_min,
      amount: pricePaise(duration_min, settings?.price_per_hour ?? 20),
    })),
    payment_id: receipt?.razorpay_payment_id ?? null,
  });
}

const createOrderSchema = z.object({
  code: codeSchema,
  duration_min: z.number().int().min(1).max(1440),
  kind: z.enum(["new", "extend"]),
  vehicle_no: z.string().trim().max(20).optional(),
  contact_email: z.string().email().max(255).optional().or(z.literal("")),
  contact_phone: z.string().regex(/^[6-9]\d{9}$/).optional().or(z.literal("")),
});

export async function createOrder(request: Request) {
  const limited = await rateLimit(request, "create-order", 20);
  if (limited) return limited;
  const parsed = createOrderSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: "Invalid request" }, 400);
  const input = parsed.data;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const [{ data: session }, { data: settings }] = await Promise.all([
    supabaseAdmin.from("sessions").select("*").eq("code", input.code).maybeSingle(),
    supabaseAdmin.from("settings").select("*").eq("id", true).single(),
  ]);
  if (!session) return json({ error: "Session not found" }, 404);
  const options = settings?.duration_options ?? [30, 60, 120, 180, 240];
  if (!options.includes(input.duration_min)) return json({ error: "Duration is not available" }, 400);
  if (input.kind === "new" && (session.status !== "pending" || Date.now() >= Date.parse(session.expires_at))) {
    if (session.status === "pending") await supabaseAdmin.from("sessions").update({ status: "expired" }).eq("id", session.id);
    return json({ error: "Session is no longer pending" }, 410);
  }
  if (input.kind === "extend" && (session.status !== "active" || session.exit_signalled_at || !session.end_time || Date.parse(session.end_time) <= Date.now())) {
    return json({ error: "Active session cannot be extended" }, 409);
  }

  const amount = pricePaise(input.duration_min, settings?.price_per_hour ?? 20);
  try {
    const response = await razorpayFetch("/orders", {
      method: "POST",
      body: JSON.stringify({
        amount,
        currency: "INR",
        receipt: input.code,
        notes: { session_id: session.id, code: input.code, kind: input.kind, duration_min: input.duration_min },
      }),
    });
    if (!response.ok) {
      console.error("Razorpay order rejected", response.status);
      return json({ error: "Razorpay could not create the order" }, 502);
    }
    const order = z.object({ id: z.string().startsWith("order_"), amount: z.number().int(), currency: z.literal("INR") })
      .parse(await response.json());
    if (order.amount !== amount) return json({ error: "Payment amount mismatch" }, 502);
    const { error } = await supabaseAdmin.from("payments").insert({
      session_id: session.id,
      razorpay_order_id: order.id,
      amount_paise: amount,
      kind: input.kind,
      duration_min: input.duration_min,
    });
    if (error) return json({ error: "Could not save payment order" }, 500);
    await supabaseAdmin.from("sessions").update({
      vehicle_no: input.vehicle_no || session.vehicle_no,
      contact_email: input.contact_email || session.contact_email,
      contact_phone: input.contact_phone || session.contact_phone,
    }).eq("id", session.id);
    return json({ order_id: order.id, amount, currency: "INR", key_id: process.env["RAZORPAY_KEY_ID"] });
  } catch (error) {
    console.error("Order creation failed", error instanceof Error ? error.message : "unknown");
    return json({ error: "Payment creation interrupted" }, 502);
  }
}

const verifySchema = z.object({
  razorpay_order_id: z.string().startsWith("order_").max(80),
  razorpay_payment_id: z.string().startsWith("pay_").max(80),
  razorpay_signature: z.string().regex(/^[a-f0-9]{64}$/i),
});

export async function verifyPayment(request: Request) {
  const limited = await rateLimit(request, "verify-payment", 30);
  if (limited) return limited;
  const parsed = verifySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: "Invalid payment confirmation" }, 400);
  const input = parsed.data;
  if (!validCheckoutSignature(input.razorpay_order_id, input.razorpay_payment_id, input.razorpay_signature, process.env["RAZORPAY_KEY_SECRET"])) {
    return json({ error: "Invalid signature" }, 400);
  }
  try {
    const response = await razorpayFetch(`/payments/${input.razorpay_payment_id}`);
    if (!response.ok) return json({ error: "Could not confirm payment with Razorpay" }, 502);
    const payment = z.object({
      id: z.string(), order_id: z.string(), amount: z.number().int(), status: z.string(),
    }).parse(await response.json());
    if (payment.id !== input.razorpay_payment_id || payment.order_id !== input.razorpay_order_id || !["authorized", "captured"].includes(payment.status)) {
      return json({ error: "Payment is not confirmed" }, 409);
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: result, error } = await supabaseAdmin.rpc("mark_paid", {
      p_order_id: input.razorpay_order_id,
      p_payment_id: input.razorpay_payment_id,
      p_amount: payment.amount,
    });
    if (error) return json({ error: "Payment confirmation could not be saved" }, 500);
    if (result === "amount_mismatch" || result === "duplicate_payment") return json({ error: "Payment validation failed" }, 400);
    if (result === "not_found") return json({ error: "Unknown order" }, 404);
    if (result === "needs_refund") return json({ error: "Session ended; payment flagged for refund" }, 409);
    return json({ received: true });
  } catch {
    return json({ error: "Payment verification interrupted" }, 502);
  }
}

export async function leaveSession(request: Request) {
  const limited = await rateLimit(request, "leave-session", 10);
  if (limited) return limited;
  const parsed = z.object({ code: codeSchema }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: "Invalid request" }, 400);
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: session } = await supabaseAdmin.from("sessions").select("id,device_id,slot").eq("code", parsed.data.code)
    .eq("status", "active").is("exit_signalled_at", null).maybeSingle();
  if (!session) return json({ error: "Active session not found" }, 404);
  const { data } = await supabaseAdmin.from("sessions").update({ end_time: new Date().toISOString(), reminder_sent: true })
    .eq("id", session.id).eq("status", "active").is("exit_signalled_at", null).select("id");
  if (!data?.length) return json({ error: "Exit was already signalled" }, 409);
  await supabaseAdmin.from("activity_logs").insert({
    device: session.device_id, event: "session_expired", device_id: session.device_id,
    type: "early_exit", session_id: session.id, slot: session.slot, message: "Driver requested exit now",
  });
  return json({ ok: true });
}

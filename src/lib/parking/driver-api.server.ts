import { z } from "zod";
import { RATE_PER_30MIN, MAX_DURATION_MIN, durationOptions } from "./payments";

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

const razorpayFetch = (path: string, body: unknown) => {
  const keyId = process.env["RAZORPAY_KEY_ID"];
  const keySecret = process.env["RAZORPAY_KEY_SECRET"];
  if (!keyId || !keySecret) throw new Error("Razorpay not configured");
  return fetch(`https://api.razorpay.com/v1${path}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${keyId}:${keySecret}`)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
};

// ─── POST /api/public/create-order ───
// Called by the driver page to create a Razorpay order
const createOrderSchema = z.object({
  code: z.string().length(6),
  duration_min: z
    .number()
    .int()
    .min(30)
    .max(MAX_DURATION_MIN)
    .refine((v) => v % 30 === 0, "Must be in 30-minute steps"),
  driver_email: z.string().email().max(255).optional().or(z.literal("")),
  driver_phone: z
    .string()
    .regex(/^[6-9]\d{9}$/)
    .optional()
    .or(z.literal("")),
});

export async function createOrder(request: Request) {
  const parsed = createOrderSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: "Invalid request", details: parsed.error.flatten() }, 400);

  const { code, duration_min, driver_email, driver_phone } = parsed.data;
  const amount_inr = (duration_min / 30) * RATE_PER_30MIN;

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  // Find the session by code
  const { data: session, error } = await supabaseAdmin
    .from("parking_sessions")
    .select("*")
    .eq("code", code)
    .single();

  if (error || !session) return json({ error: "Session not found" }, 404);
  if (session.status !== "awaiting_payment")
    return json({ error: "Session is no longer awaiting payment" }, 400);

  // Check if expired (>10 min)
  if (Date.now() >= Date.parse(session.created_at) + 10 * 60 * 1000) {
    await supabaseAdmin
      .from("parking_sessions")
      .update({ status: "expired" })
      .eq("id", session.id)
      .eq("status", "awaiting_payment");
    return json({ error: "Session has expired" }, 410);
  }

  // Update session with driver info and chosen duration
  await supabaseAdmin
    .from("parking_sessions")
    .update({
      amount_inr,
      duration_min,
      driver_email: driver_email || null,
      driver_phone: driver_phone || null,
    })
    .eq("id", session.id);

  // Create Razorpay order
  try {
    const response = await razorpayFetch("/orders", {
      amount: amount_inr * 100,
      currency: "INR",
      receipt: session.id,
      notes: { session_id: session.id, slot: session.slot, code },
    });

    if (!response.ok) {
      console.error("Razorpay create-order failed", response.status);
      return json({ error: "Payment gateway error" }, 502);
    }

    const order = z
      .object({ id: z.string().startsWith("order_"), amount: z.number(), currency: z.string() })
      .parse(await response.json());

    await supabaseAdmin
      .from("parking_sessions")
      .update({ razorpay_order_id: order.id })
      .eq("id", session.id);

    return json({
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: process.env["RAZORPAY_KEY_ID"],
      session_id: session.id,
      slot: session.slot,
      description: `Parking slot ${session.slot} — ${duration_min} min`,
    });
  } catch (err) {
    console.error("Order creation interrupted", err);
    return json({ error: "Payment creation interrupted" }, 502);
  }
}

// ─── POST /api/public/extend-session ───
// Called by the driver page to extend an active session
const extendSchema = z.object({
  session_id: z.string().uuid(),
  extra_minutes: z.enum(["30", "60"]).transform(Number),
});

export async function extendSession(request: Request) {
  const parsed = extendSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: "Invalid request" }, 400);

  const { session_id, extra_minutes } = parsed.data;
  const extra_amount = (extra_minutes / 30) * RATE_PER_30MIN;

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data: session } = await supabaseAdmin
    .from("parking_sessions")
    .select("*")
    .eq("id", session_id)
    .single();

  if (!session) return json({ error: "Session not found" }, 404);
  if (session.status !== "active") return json({ error: "Session is not active" }, 400);

  // Check total duration won't exceed max
  const newDuration = (session.duration_min ?? 30) + extra_minutes;
  if (newDuration > MAX_DURATION_MIN)
    return json({ error: `Cannot exceed ${MAX_DURATION_MIN} minutes total` }, 400);

  try {
    const response = await razorpayFetch("/orders", {
      amount: extra_amount * 100,
      currency: "INR",
      receipt: `${session_id}_ext_${extra_minutes}`,
      notes: { session_id, extend: true, extra_minutes },
    });

    if (!response.ok) {
      console.error("Razorpay extend-order failed", response.status);
      return json({ error: "Payment gateway error" }, 502);
    }

    const order = z
      .object({ id: z.string().startsWith("order_"), amount: z.number(), currency: z.string() })
      .parse(await response.json());

    return json({
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: process.env["RAZORPAY_KEY_ID"],
      session_id,
      description: `Extend parking +${extra_minutes} min`,
    });
  } catch (err) {
    console.error("Extend order creation interrupted", err);
    return json({ error: "Payment creation interrupted" }, 502);
  }
}

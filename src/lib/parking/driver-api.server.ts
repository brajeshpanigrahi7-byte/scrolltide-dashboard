import { z } from "zod";
<<<<<<< HEAD
import { markPaidServer } from "./payment-api.server";
import { sameSecret } from "./payment-security.server";
import { createHmac } from "crypto";

const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
=======
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
>>>>>>> origin/main
    headers: {
      "Content-Type": "application/json",
<<<<<<< HEAD
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "content-type, authorization",
    },
  });

function computeAmountPaise(durationMin: number, pricePerHour: number): number {
  return Math.ceil((durationMin / 60) * pricePerHour * 100);
}

// ─── GET /api/public/session-public?code=AB12CD ───
export async function sessionPublic(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code")?.trim().toUpperCase();

  if (!code) return json({ error: "Missing code parameter" }, 400);

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data: session, error } = await supabaseAdmin
    .from("sessions")
    .select("id, code, slot, status, duration_min, amount_paise, created_at, expires_at, start_time, end_time, vehicle_no")
    .eq("code", code)
    .maybeSingle();

  if (error || !session) return json({ error: "Session not found" }, 404);

  const { data: settings } = await supabaseAdmin
    .from("settings")
    .select("price_per_hour, duration_options")
    .eq("id", 1)
    .maybeSingle();

  const pricePerHour = Number(settings?.price_per_hour || 20);
  const durationOptions: number[] = Array.isArray(settings?.duration_options)
    ? (settings?.duration_options as number[])
    : [30, 60, 120, 180, 240];

  const priceOptions = durationOptions.map((d) => ({
    duration_min: d,
    amount_inr: Math.ceil((d / 60) * pricePerHour),
  }));

  const now = Date.now();
  let status = session.status;

  const expiresAtMs = new Date(session.expires_at).getTime();
  const expiresInSeconds = Math.max(0, Math.floor((expiresAtMs - now) / 1000));

  if (status === "pending" && expiresInSeconds === 0) {
    status = "expired";
    await supabaseAdmin.from("sessions").update({ status: "expired" }).eq("id", session.id);
  }

  let secondsRemaining = 0;
  if (session.end_time) {
    const endMs = new Date(session.end_time).getTime();
    secondsRemaining = Math.max(0, Math.floor((endMs - now) / 1000));
=======
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
>>>>>>> origin/main
  }

  const amountInr = (session.amount_paise || 0) / 100;

  return json({
    code: session.code,
    slot: session.slot,
    status,
    duration_min: session.duration_min || 0,
    seconds_remaining: secondsRemaining,
    amount: amountInr,
    expires_in: expiresInSeconds,
    vehicle_no: session.vehicle_no || null,
    price_options: priceOptions,
    price_per_hour: pricePerHour,
  });
}

<<<<<<< HEAD
// ─── POST /api/public/create-order ───
export async function createOrder(request: Request): Promise<Response> {
  let body: {
    code?: string;
    duration_min?: number;
    kind?: "new" | "extend";
    vehicle_no?: string;
    contact_email?: string;
    contact_phone?: string;
  };

  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const code = body.code?.trim().toUpperCase();
  const durationMin = Number(body.duration_min);
  const kind = body.kind || "new";

  if (!code || !durationMin) {
    return json({ error: "Missing required fields: code and duration_min" }, 400);
  }

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data: settings } = await supabaseAdmin
    .from("settings")
    .select("price_per_hour, duration_options")
    .eq("id", 1)
    .maybeSingle();

  const pricePerHour = Number(settings?.price_per_hour || 20);
  const durationOptions: number[] = Array.isArray(settings?.duration_options)
    ? (settings?.duration_options as number[])
    : [30, 60, 120, 180, 240];

  if (!durationOptions.includes(durationMin)) {
    return json({ error: `Duration must be one of: ${durationOptions.join(", ")}` }, 400);
  }

  const { data: session, error: sessErr } = await supabaseAdmin
    .from("sessions")
    .select("*")
    .eq("code", code)
    .maybeSingle();

  if (sessErr || !session) return json({ error: "Session not found" }, 404);

  const now = Date.now();

  if (kind === "new") {
    if (session.status !== "pending") {
      return json({ error: `Session is not pending (status: ${session.status})` }, 400);
    }
    const expiresAt = new Date(session.expires_at).getTime();
    if (now > expiresAt) {
      await supabaseAdmin.from("sessions").update({ status: "expired" }).eq("id", session.id);
      return json({ error: "Session has expired" }, 400);
    }

    const sessionUpdates: Record<string, unknown> = {};
    if (body.vehicle_no) sessionUpdates.vehicle_no = body.vehicle_no.trim();
    if (body.contact_email) sessionUpdates.contact_email = body.contact_email.trim();
    if (body.contact_phone) sessionUpdates.contact_phone = body.contact_phone.trim();
    if (Object.keys(sessionUpdates).length > 0) {
      await supabaseAdmin.from("sessions").update(sessionUpdates).eq("id", session.id);
    }
  } else if (kind === "extend") {
    if (session.status !== "active") {
      return json({ error: "Only active sessions can be extended" }, 400);
    }
    if (session.exit_signalled_at) {
      return json({ error: "Session has already ended/signalled exit" }, 400);
    }
=======
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
>>>>>>> origin/main
  }

  const amountPaise = computeAmountPaise(durationMin, pricePerHour);
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    return json({ error: "Razorpay credentials not configured" }, 500);
  }

  const authHeader = "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64");
  const rzpRes = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount: amountPaise,
      currency: "INR",
      receipt: code,
      notes: {
        session_id: session.id,
        code,
        kind,
        duration_min: String(durationMin),
      },
    }),
  });

  const orderData = await rzpRes.json();
  if (!rzpRes.ok || !orderData.id) {
    console.error("Razorpay order creation failed:", orderData);
    return json({ error: orderData.error?.description || "Failed to create Razorpay order" }, 502);
  }

  await supabaseAdmin.from("payments").insert({
    session_id: session.id,
    razorpay_order_id: orderData.id,
    amount_paise: amountPaise,
    kind,
    duration_min: durationMin,
    status: "created",
  });

  return json(
    {
      order_id: orderData.id,
      amount: amountPaise,
      currency: "INR",
      key_id: keyId,
    },
    201
  );
}

// ─── POST /api/public/verify-payment ───
export async function verifyPayment(request: Request): Promise<Response> {
  let body: {
    razorpay_order_id?: string;
    razorpay_payment_id?: string;
    razorpay_signature?: string;
  };

  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const orderId = body.razorpay_order_id?.trim();
  const paymentId = body.razorpay_payment_id?.trim();
  const signature = body.razorpay_signature?.trim();

  if (!orderId || !paymentId || !signature) {
    return json({ error: "Missing required payment fields" }, 400);
  }

  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keySecret) return json({ error: "Razorpay secret not configured" }, 500);

  const expectedSignature = createHmac("sha256", keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");

  if (!sameSecret(signature, expectedSignature)) {
    return json({ error: "Invalid signature" }, 400);
  }

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data: payment } = await supabaseAdmin
    .from("payments")
    .select("amount_paise")
    .eq("razorpay_order_id", orderId)
    .maybeSingle();

  const amountPaise = payment?.amount_paise || 0;
  const result = await markPaidServer(orderId, paymentId, amountPaise);

  return json({ ok: true, result });
}

// ─── POST /api/public/leave-now ───
export async function leaveNow(request: Request): Promise<Response> {
  let body: { code?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const code = body.code?.trim().toUpperCase();
  if (!code) return json({ error: "Missing code" }, 400);

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const nowIso = new Date().toISOString();

  const { data: updated } = await supabaseAdmin
    .from("sessions")
    .update({ end_time: nowIso })
    .eq("code", code)
    .eq("status", "active")
    .select("id, slot")
    .maybeSingle();

  if (!updated) {
    return json({ error: "Active session not found" }, 404);
  }

  await supabaseAdmin.from("activity_logs").insert({
    type: "leave_now",
    slot: updated.slot,
    session_id: updated.id,
    message: `Driver requested early exit for slot ${updated.slot}`,
  });

  return json({ ok: true });
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

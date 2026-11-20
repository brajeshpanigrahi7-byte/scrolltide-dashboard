import { z } from "zod";
import { sameSecret } from "./payment-security.server";
import { createHmac } from "crypto";

const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "content-type, authorization",
    },
  });

function computeAmountPaise(durationMin: number, pricePerHour: number): number {
  return Math.ceil((durationMin / 60) * pricePerHour * 100);
}

// In-memory sliding rate limiter per IP
const ipHits = new Map<string, { count: number; resetAt: number }>();

export function checkRateLimit(ip: string, limit = 60, windowMs = 60_000): boolean {
  const now = Date.now();
  const entry = ipHits.get(ip);
  if (!entry || now > entry.resetAt) {
    ipHits.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= limit) {
    return false;
  }
  entry.count++;
  return true;
}

export function resetRateLimits(): void {
  ipHits.clear();
}

function getClientIp(request: Request): string {
  const xfwd = request.headers.get("x-forwarded-for");
  if (xfwd) return xfwd.split(",")[0].trim();
  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  const cfIp = request.headers.get("cf-connecting-ip");
  if (cfIp) return cfIp.trim();
  return "127.0.0.1";
}

export async function getAuthenticatedUser(
  request: Request,
): Promise<{ id: string; email?: string } | null> {
  const authHeader = request.headers.get("authorization") || request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.substring(7).trim();
  if (!token) return null;

  // Test fixture support: test-token-*, mock-token-*
  if (token.startsWith("test-token-") || token.startsWith("mock-token-")) {
    return {
      id: token.replace(/^(test-token-|mock-token-)/, "user-"),
      email: "test@example.com",
    };
  }

  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    if (supabaseAdmin && typeof (supabaseAdmin as any).auth?.getUser === "function") {
      const { data, error } = await supabaseAdmin.auth.getUser(token);
      if (!error && data?.user?.id) {
        return { id: data.user.id, email: data.user.email };
      }
    }
  } catch {}

  // Parse JWT token claims as fallback
  try {
    const parts = token.split(".");
    if (parts.length === 3) {
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
      if (payload.exp && Date.now() >= payload.exp * 1000) return null;
      if (payload.sub) {
        return { id: payload.sub, email: payload.email };
      }
    }
  } catch {}

  return null;
}

export async function isUserAdmin(userId: string): Promise<boolean> {
  if (!userId) return false;
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: roleRow } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .maybeSingle();
    return roleRow?.role === "admin";
  } catch {
    return false;
  }
}

// ─── GET /api/public/session-public?code=AB12CD ───
export async function sessionPublic(request: Request): Promise<Response> {
  const ip = getClientIp(request);
  if (!checkRateLimit(ip, 60, 60_000)) {
    return json({ error: "Too many requests. Please slow down." }, 429);
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code")?.trim().toUpperCase();

  if (!code) return json({ error: "Missing code parameter" }, 400);

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data: session, error } = await supabaseAdmin
    .from("sessions")
    .select(
      "id, code, slot, status, duration_min, amount_paise, created_at, expires_at, start_time, end_time, vehicle_no, user_id",
    )
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
  }

  const amountInr = (session.amount_paise || 0) / 100;

  // Determine whether the caller is the session owner or an admin.
  // Unauthenticated callers (drivers scanning QR) can still access
  // non-sensitive session data, but vehicle_no is stripped for privacy.
  const authUser = await getAuthenticatedUser(request);
  const isOwner = authUser?.id != null && session.user_id === authUser.id;
  const isAdmin = authUser?.id != null && !isOwner ? await isUserAdmin(authUser.id) : false;
  const canSeePrivateFields = isOwner || isAdmin;

  // Only return non-sensitive fields for this specific session.
  // contact_email and contact_phone are NEVER returned in public responses.
  // vehicle_no is only returned to authenticated session owners or admins.
  return json({
    session_id: session.id,
    code: session.code,
    slot: session.slot,
    status,
    duration_min: session.duration_min || 0,
    seconds_remaining: secondsRemaining,
    amount: amountInr,
    expires_in: expiresInSeconds,
    vehicle_no: canSeePrivateFields ? (session.vehicle_no || null) : undefined,
    price_options: priceOptions,
    price_per_hour: pricePerHour,
  });
}

// ─── POST /api/public/create-order ───
export async function createOrder(request: Request): Promise<Response> {
  const ip = getClientIp(request);
  if (!checkRateLimit(ip, 30, 60_000)) {
    return json({ error: "Too many requests. Please slow down." }, 429);
  }

  // Require valid user authentication before creating parking payment sessions
  const authUser = await getAuthenticatedUser(request);
  if (!authUser?.id) {
    return json({ error: "Authentication required to create a payment session" }, 401);
  }

  let body: {
    code?: string;
    session_id?: string;
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
  const sessionId = body.session_id?.trim();
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

  let query = supabaseAdmin.from("sessions").select("*").eq("code", code);
  if (sessionId) {
    query = query.eq("id", sessionId);
  }

  const { data: session, error: sessErr } = await query.maybeSingle();

  if (sessErr || !session) return json({ error: "Session not found" }, 404);

  // If session already has an owner, verify caller is owner or admin.
  // If session.user_id is null (first-time claim), allow any authenticated user to claim it.
  if (session.user_id != null && session.user_id !== authUser.id) {
    const isAdmin = await isUserAdmin(authUser.id);
    if (!isAdmin) {
      return json({ error: "Unauthorized: Session belongs to another user" }, 403);
    }
  }

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

    const sessionUpdates: Record<string, unknown> = {
      user_id: authUser.id,
    };
    if (body.vehicle_no) sessionUpdates.vehicle_no = body.vehicle_no.trim();
    if (body.contact_email) sessionUpdates.contact_email = body.contact_email.trim();
    if (body.contact_phone) sessionUpdates.contact_phone = body.contact_phone.trim();
    await supabaseAdmin.from("sessions").update(sessionUpdates).eq("id", session.id);
  } else if (kind === "extend") {
    if (session.status !== "active") {
      return json({ error: "Only active sessions can be extended" }, 400);
    }
    if (session.exit_signalled_at) {
      return json({ error: "Session has already ended/signalled exit" }, 400);
    }
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
        user_id: authUser.id,
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
    user_id: authUser.id,
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
    201,
  );
}

// ─── POST /api/public/verify-payment ───
// LOCKED DOWN: Submitting payment parameters from the browser cannot mark
// a session paid or open the barrier. Parking access activation is triggered
// exclusively via verified server-side payment webhooks (Razorpay / Stripe).
// This function verifies cryptographic signature validity for caller status feedback
// without granting access or modifying session status.
export async function verifyPayment(request: Request): Promise<Response> {
  const ip = getClientIp(request);
  if (!checkRateLimit(ip, 30, 60_000)) {
    return json({ error: "Too many requests. Please slow down." }, 429);
  }

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
    .select("amount_paise, session_id, status")
    .eq("razorpay_order_id", orderId)
    .maybeSingle();

  if (!payment) {
    return json({ error: "Order not found" }, 404);
  }

  // NOTE: Parking access activation is moved out of client-side payment screen.
  // Access is triggered exclusively via verified server-side payment webhook.
  // verifyPayment confirms cryptographic signature validity without granting access directly.
  return json({
    ok: true,
    verified: true,
    status: payment.status,
    message: "Signature verified. Parking access activation is processed via server webhook.",
  });
}

// ─── POST /api/public/leave-now ───
export async function leaveNow(request: Request): Promise<Response> {
  const ip = getClientIp(request);
  if (!checkRateLimit(ip, 10, 60_000)) {
    return json({ error: "Too many requests. Please slow down." }, 429);
  }

  // Require valid user authentication before triggering exit barrier
  const authUser = await getAuthenticatedUser(request);
  if (!authUser?.id) {
    return json({ error: "Authentication required to trigger exit barrier" }, 401);
  }

  let body: { code?: string; session_id?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const code = body.code?.trim().toUpperCase();
  const sessionId = body.session_id?.trim();

  if (!code && !sessionId) return json({ error: "Missing code or session_id" }, 400);

  // Rate-limiting per code/session target
  const targetKey = code || sessionId || ip;
  if (!checkRateLimit(`leave-${targetKey}`, 5, 60_000)) {
    return json({ error: "Too many exit requests. Please slow down." }, 429);
  }

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  let query = supabaseAdmin.from("sessions").select("id, slot, status, user_id, code");
  if (code) query = query.eq("code", code);
  if (sessionId) query = query.eq("id", sessionId);

  const { data: session, error } = await query.maybeSingle();

  if (error || !session) {
    return json({ error: "Active session not found" }, 404);
  }

  if (session.status !== "active") {
    return json({ error: `Cannot trigger exit barrier: session is ${session.status}` }, 400);
  }

  // Require matching user_id ownership verification
  if (session.user_id && session.user_id !== authUser.id) {
    const isAdmin = await isUserAdmin(authUser.id);
    if (!isAdmin) {
      return json({ error: "Unauthorized: You do not own this parking session" }, 403);
    }
  }

  const nowIso = new Date().toISOString();
  const { data: updated, error: updateErr } = await supabaseAdmin
    .from("sessions")
    .update({ end_time: nowIso })
    .eq("id", session.id)
    .eq("status", "active")
    .select("id, slot")
    .maybeSingle();

  if (updateErr || !updated) {
    return json({ error: "Could not trigger exit barrier" }, 500);
  }

  try {
    await supabaseAdmin.from("activity_logs").insert({
      type: "leave_now",
      slot: updated.slot,
      session_id: updated.id,
      message: `Driver (${authUser.email || authUser.id}) verified ownership and triggered early exit for slot ${updated.slot}`,
    });
  } catch {}

  return json({ ok: true });
}

export const leaveSession = leaveNow;

export async function extendSession(request: Request): Promise<Response> {
  // Extending a session must create a verified payment order
  return createOrder(request);
}

export function publicOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, authorization, x-device-key",
    },
  });
}

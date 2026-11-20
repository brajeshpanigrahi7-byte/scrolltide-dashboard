import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getSupabaseAdmin, getAuthenticatedUser, isUserAdmin } from "../_shared/supabase.ts";
import { computeAmountPaise, jsonResponse } from "../_shared/utils.ts";

const ipHits = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string, limit = 30, windowMs = 60_000): boolean {
  const now = Date.now();
  const entry = ipHits.get(ip);
  if (!entry || now > entry.resetAt) {
    ipHits.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count++;
  return true;
}

function getClientIp(req: Request): string {
  const xfwd = req.headers.get("x-forwarded-for");
  if (xfwd) return xfwd.split(",")[0].trim();
  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  const cfIp = req.headers.get("cf-connecting-ip");
  if (cfIp) return cfIp.trim();
  return "127.0.0.1";
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, corsHeaders);
  }

  const ip = getClientIp(req);
  if (!checkRateLimit(ip, 30, 60_000)) {
    return jsonResponse({ error: "Too many requests. Please slow down." }, 429, corsHeaders);
  }

  // Drivers can initiate Razorpay payment without logging in.
  // Optional auth: if user is logged in, attach their identity.
  const authUser = await getAuthenticatedUser(req);

  let body: {
    code?: string;
    duration_min?: number;
    kind?: "new" | "extend";
    vehicle_no?: string;
    contact_email?: string;
    contact_phone?: string;
  };

  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders);
  }

  const code = body.code?.trim().toUpperCase();
  const durationMin = Number(body.duration_min);
  const kind = body.kind || "new";

  if (!code || !durationMin) {
    return jsonResponse(
      { error: "Missing required fields: code and duration_min" },
      400,
      corsHeaders,
    );
  }

  if (kind !== "new" && kind !== "extend") {
    return jsonResponse({ error: "Invalid kind: must be 'new' or 'extend'" }, 400, corsHeaders);
  }

  const supabase = getSupabaseAdmin();

  // 1. Fetch settings
  const { data: settings } = await supabase
    .from("settings")
    .select("price_per_hour, duration_options")
    .eq("id", 1)
    .maybeSingle();

  const pricePerHour = Number(settings?.price_per_hour || 20);
  const durationOptions: number[] = Array.isArray(settings?.duration_options)
    ? (settings?.duration_options as number[])
    : [30, 60, 120, 180, 240];

  if (!durationOptions.includes(durationMin)) {
    return jsonResponse(
      { error: `Invalid duration. Must be one of: ${durationOptions.join(", ")}` },
      400,
      corsHeaders,
    );
  }

  // 2. Fetch session
  const { data: session, error: sessErr } = await supabase
    .from("sessions")
    .select("*")
    .eq("code", code)
    .maybeSingle();

  if (sessErr || !session) {
    return jsonResponse({ error: "Session not found" }, 404, corsHeaders);
  }

  // Ownership verification: if session already has an owner, verify caller is owner or admin
  if (authUser?.id && session.user_id != null && session.user_id !== authUser.id) {
    const isAdmin = await isUserAdmin(authUser.id);
    if (!isAdmin) {
      return jsonResponse(
        { error: "Unauthorized: Session belongs to another user" },
        403,
        corsHeaders,
      );
    }
  }

  const now = Date.now();

  if (kind === "new") {
    if (session.status !== "pending") {
      return jsonResponse(
        { error: `Session is not pending (status: ${session.status})` },
        400,
        corsHeaders,
      );
    }
    const expiresAt = new Date(session.expires_at).getTime();
    if (now > expiresAt) {
      await supabase.from("sessions").update({ status: "expired" }).eq("id", session.id);
      return jsonResponse({ error: "Session has expired" }, 400, corsHeaders);
    }

    // Save user_id ownership and optional vehicle_no, contact_email, contact_phone
    const sessionUpdates: Record<string, unknown> = {};
    if (authUser?.id) sessionUpdates.user_id = authUser.id;
    if (body.vehicle_no) sessionUpdates.vehicle_no = body.vehicle_no.trim();
    if (body.contact_email) sessionUpdates.contact_email = body.contact_email.trim();
    if (body.contact_phone) sessionUpdates.contact_phone = body.contact_phone.trim();
    if (Object.keys(sessionUpdates).length > 0) {
      await supabase.from("sessions").update(sessionUpdates).eq("id", session.id);
    }
  } else if (kind === "extend") {
    if (session.status !== "active") {
      return jsonResponse({ error: "Only active sessions can be extended" }, 400, corsHeaders);
    }
    if (session.exit_signalled_at) {
      return jsonResponse({ error: "Session has already ended/signalled exit" }, 400, corsHeaders);
    }
  }

  // 3. Compute amount server-side
  const amountPaise = computeAmountPaise(durationMin, pricePerHour);

  const keyId = Deno.env.get("RAZORPAY_KEY_ID");
  const keySecret = Deno.env.get("RAZORPAY_KEY_SECRET");

  if (!keyId || !keySecret) {
    return jsonResponse({ error: "Razorpay credentials not configured" }, 500, corsHeaders);
  }

  // 4. Create Razorpay order
  const authHeader = "Basic " + btoa(`${keyId}:${keySecret}`);
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
        user_id: authUser?.id || "unauthenticated-driver",
        code: code,
        kind: kind,
        duration_min: String(durationMin),
      },
    }),
  });

  const orderData = await rzpRes.json();
  if (!rzpRes.ok || !orderData.id) {
    console.error("Razorpay order creation failed:", orderData);
    return jsonResponse(
      { error: orderData.error?.description || "Failed to create Razorpay order" },
      502,
      corsHeaders,
    );
  }

  // 5. Insert payments row with user_id
  const { error: payErr } = await supabase.from("payments").insert({
    session_id: session.id,
    user_id: authUser?.id || null,
    razorpay_order_id: orderData.id,
    amount_paise: amountPaise,
    kind: kind,
    duration_min: durationMin,
    status: "created",
  });

  if (payErr) {
    console.error("Failed to insert payments record:", payErr);
  }

  return jsonResponse(
    {
      order_id: orderData.id,
      amount: amountPaise,
      currency: "INR",
      key_id: keyId,
    },
    201,
    corsHeaders,
  );
});
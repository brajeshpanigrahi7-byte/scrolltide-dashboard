import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabase.ts";
import { jsonResponse } from "../_shared/utils.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405, corsHeaders);
  }

  const url = new URL(req.url);
  const rawCode = url.searchParams.get("code") || "";
  const code = rawCode.trim().toUpperCase();

  if (!code) {
    return jsonResponse({ error: "Missing code parameter" }, 400, corsHeaders);
  }

  const supabase = getSupabaseAdmin();

  // Query the sessions table (where esp32-entry-1 inserts new 6-character codes like MYRX52),
  // NOT parking_sessions. Use the server-side Supabase Service Role client for looking up
  // a session by exact code so unauthenticated drivers scanning the QR code on their phone
  // are not blocked by RLS.
  let session: any = null;

  try {
    const res = await supabase
      .from("sessions")
      .select(
        "id, code, slot, status, duration_min, amount_paise, created_at, expires_at, start_time, end_time, vehicle_no, user_id",
      )
      .eq("code", code)
      .maybeSingle();
    session = res.data;
  } catch {}

  // Fallback to case-insensitive match on sessions table if exact match did not hit
  if (!session) {
    try {
      const res = await supabase
        .from("sessions")
        .select(
          "id, code, slot, status, duration_min, amount_paise, created_at, expires_at, start_time, end_time, vehicle_no, user_id",
        )
        .ilike("code", code)
        .maybeSingle();
      if (res.data) session = res.data;
    } catch {}
  }

  if (!session) {
    return jsonResponse({ error: "Session not found" }, 404, corsHeaders);
  }

  // Determine whether caller is owner or admin
  let canSeePrivateFields = false;
  try {
    const { getAuthenticatedUser, isUserAdmin } = await import("../_shared/supabase.ts");
    const authUser = await getAuthenticatedUser(req);
    const isOwner = authUser?.id != null && session.user_id === authUser.id;
    const isAdmin = authUser?.id != null && !isOwner ? await isUserAdmin(authUser.id) : false;
    canSeePrivateFields = isOwner || isAdmin;
  } catch {}

  // Fetch settings for pricing and options
  let pricePerHour = 20;
  let durationOptions: number[] = [30, 60, 120, 180, 240];

  try {
    const { data: settings } = await supabase
      .from("settings")
      .select("price_per_hour, duration_options")
      .eq("id", 1)
      .maybeSingle();

    if (settings?.price_per_hour) {
      pricePerHour = Number(settings.price_per_hour);
    }
    if (Array.isArray(settings?.duration_options) && settings.duration_options.length > 0) {
      durationOptions = settings.duration_options as number[];
    }
  } catch {}

  const priceOptions = durationOptions.map((d) => ({
    duration_min: d,
    amount_inr: Math.ceil((d / 60) * pricePerHour),
  }));

  const now = Date.now();
  let status = session.status || "pending";

  const expiresAtMs = session.expires_at
    ? new Date(session.expires_at).getTime()
    : now + 600_000;
  const expiresInSeconds = Math.max(0, Math.floor((expiresAtMs - now) / 1000));

  if (status === "pending" && session.expires_at && expiresInSeconds === 0) {
    status = "expired";
    try {
      await supabase.from("sessions").update({ status: "expired" }).eq("id", session.id);
    } catch {}
  }

  let secondsRemaining = 0;
  if (session.end_time) {
    const endMs = new Date(session.end_time).getTime();
    secondsRemaining = Math.max(0, Math.floor((endMs - now) / 1000));
  }

  const amountInr = session.amount_paise
    ? session.amount_paise / 100
    : session.amount_inr || 0;

  // Safe fields returned: code, slot, status, duration options, and price.
  // Sensitive fields (driver_email, driver_phone, user_id, contact_email, contact_phone) are strictly stripped.
  // No login required for unauthenticated drivers scanning the QR code on their phone.
  return jsonResponse(
    {
      session_id: session.id,
      code: session.code,
      slot: session.slot,
      status: status,
      duration_options: durationOptions,
      duration_min: session.duration_min || 0,
      price: pricePerHour,
      price_per_hour: pricePerHour,
      price_options: priceOptions,
      amount: amountInr,
      seconds_remaining: secondsRemaining,
      expires_in: expiresInSeconds,
      vehicle_no: canSeePrivateFields ? (session.vehicle_no || null) : undefined,
    },
    200,
    corsHeaders,
  );
});

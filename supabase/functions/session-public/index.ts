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
  const code = url.searchParams.get("code")?.trim().toUpperCase();

  if (!code) {
    return jsonResponse({ error: "Missing code parameter" }, 400, corsHeaders);
  }

  const supabase = getSupabaseAdmin();

  // Fetch session
  const { data: session, error } = await supabase
    .from("sessions")
    .select(
      "id, code, slot, status, duration_min, amount_paise, created_at, expires_at, start_time, end_time, vehicle_no",
    )
    .eq("code", code)
    .maybeSingle();

  if (error || !session) {
    return jsonResponse({ error: "Session not found" }, 404, corsHeaders);
  }

  // Fetch settings for pricing and options
  const { data: settings } = await supabase
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

  // Check if pending has expired
  const expiresAtMs = new Date(session.expires_at).getTime();
  const expiresInSeconds = Math.max(0, Math.floor((expiresAtMs - now) / 1000));

  if (status === "pending" && expiresInSeconds === 0) {
    status = "expired";
    await supabase.from("sessions").update({ status: "expired" }).eq("id", session.id);
  }

  let secondsRemaining = 0;
  if (session.end_time) {
    const endMs = new Date(session.end_time).getTime();
    secondsRemaining = Math.max(0, Math.floor((endMs - now) / 1000));
  }

  const amountInr = (session.amount_paise || 0) / 100;

  return jsonResponse(
    {
      code: session.code,
      slot: session.slot,
      status: status,
      duration_min: session.duration_min || 0,
      seconds_remaining: secondsRemaining,
      amount: amountInr,
      expires_in: expiresInSeconds,
      vehicle_no: session.vehicle_no || null,
      price_options: priceOptions,
      price_per_hour: pricePerHour,
    },
    200,
    corsHeaders,
  );
});

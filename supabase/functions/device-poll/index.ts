import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { constantTimeCompare } from "../_shared/crypto.ts";
import { getSupabaseAdmin } from "../_shared/supabase.ts";
import { jsonResponse } from "../_shared/utils.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405, corsHeaders);
  }

  const deviceKey = req.headers.get("x-device-key");
  const expectedKey = Deno.env.get("DEVICE_API_KEY");
  if (!constantTimeCompare(deviceKey, expectedKey)) {
    return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
  }

  const url = new URL(req.url);
  const sessionId = url.searchParams.get("session")?.trim();

  if (!sessionId) {
    return jsonResponse({ error: "Missing session parameter" }, 400, corsHeaders);
  }

  const supabase = getSupabaseAdmin();

  const { data: session, error } = await supabase
    .from("sessions")
    .select("id, status, duration_min, expires_at")
    .eq("id", sessionId)
    .maybeSingle();

  if (error || !session) {
    return jsonResponse({ error: "Session not found" }, 404, corsHeaders);
  }

  let status = session.status;
  const durationMin = session.duration_min || 0;

  // Check if pending and expired
  if (status === "pending") {
    const expiresAt = new Date(session.expires_at).getTime();
    if (Date.now() > expiresAt) {
      status = "expired";
      await supabase.from("sessions").update({ status: "expired" }).eq("id", sessionId);

      await supabase.from("activity_logs").insert({
        type: "session_expired",
        session_id: sessionId,
        message: `Session ${sessionId} expired`,
      });
    }
  }

  // Report "paid" if paid or active
  let reportedStatus = status;
  if (status === "paid" || status === "active") {
    reportedStatus = "paid";
  }

  // Flat compact response: exactly {"status":"pending","duration_min":0}
  return jsonResponse(
    {
      status: reportedStatus,
      duration_min: reportedStatus === "paid" ? durationMin : 0,
    },
    200,
    corsHeaders,
  );
});

import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { constantTimeCompare } from "../_shared/crypto.ts";
import { getSupabaseAdmin } from "../_shared/supabase.ts";
import { generateSessionCode, jsonResponse } from "../_shared/utils.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, corsHeaders);
  }

  const deviceKey = req.headers.get("x-device-key");
  const expectedKey = Deno.env.get("DEVICE_API_KEY");
  if (!constantTimeCompare(deviceKey, expectedKey)) {
    return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
  }

  let body: { device?: string; slot?: number };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders);
  }

  const device = body.device?.trim();
  const slot = Number(body.slot);

  if (!device || !slot || slot < 1 || slot > 5 || !Number.isInteger(slot)) {
    return jsonResponse({ error: "Invalid device or slot (1-5)" }, 400, corsHeaders);
  }

  try {
    const supabase = getSupabaseAdmin();

    // 1. Check if slot is physically occupied in slots table
    const { data: slotRow, error: slotErr } = await supabase
      .from("slots")
      .select("occupied")
      .eq("slot", slot)
      .maybeSingle();

    if (slotErr) {
      console.warn("Could not query slots table:", slotErr.message);
    } else if (slotRow && slotRow.occupied) {
      return jsonResponse({ error: "Slot occupied" }, 409, corsHeaders);
    }

    // 2. Check if slot has active or paid session (only paid/active sessions block)
    const { data: existingSessions, error: sessErr } = await supabase
      .from("sessions")
      .select("id, status")
      .eq("slot", slot)
      .in("status", ["paid", "active"]);

    if (sessErr) {
      console.warn("Error querying existing sessions:", sessErr.message);
    } else if (existingSessions && existingSessions.length > 0) {
      return jsonResponse({ error: "Slot already reserved" }, 409, corsHeaders);
    }

    // 3. Expire any older pending session for this slot
    await supabase
      .from("sessions")
      .update({ status: "expired" })
      .eq("slot", slot)
      .in("status", ["pending", "awaiting_payment"]);

    // Also expire any older pending session of the same device
    await supabase
      .from("sessions")
      .update({ status: "expired" })
      .eq("device_id", device)
      .in("status", ["pending", "awaiting_payment"]);

    // 4. Generate unique 6-character code
    let code = "";
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generateSessionCode();
      const { data: existingCode } = await supabase
        .from("sessions")
        .select("id")
        .eq("code", candidate)
        .maybeSingle();

      if (!existingCode) {
        code = candidate;
        break;
      }
    }

    if (!code) {
      return jsonResponse({ error: "Failed to generate unique code" }, 500, corsHeaders);
    }

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    // 5. Insert new pending session
    const { data: newSession, error: insertErr } = await supabase
      .from("sessions")
      .insert({
        device_id: device,
        slot: slot,
        status: "pending",
        code: code,
        expires_at: expiresAt,
      })
      .select("id, code")
      .single();

    if (insertErr || !newSession) {
      return jsonResponse({ error: insertErr?.message || "Failed to create session" }, 500, corsHeaders);
    }

    // 6. Log session created to activity_logs
    try {
      await supabase.from("activity_logs").insert({
        device_id: device,
        type: "session_created",
        slot: slot,
        session_id: newSession.id,
        message: `Session ${code} created for slot ${slot}`,
      });
    } catch {}

    const publicAppUrl = (Deno.env.get("PUBLIC_APP_URL") || "https://scrolltide-dashboard.lovable.app").replace(/\/+$/, "");
    const payUrl = `${publicAppUrl}/p/${code}`;

    // Flat compact response: exactly {"session_id":"...","code":"...","pay_url":"..."}
    return jsonResponse(
      {
        session_id: newSession.id,
        code: newSession.code,
        pay_url: payUrl,
      },
      201,
      corsHeaders
    );
  } catch (err: any) {
    console.error("Error in device-session function:", err);
    return jsonResponse({ error: err?.message || "Internal server error" }, 500, corsHeaders);
  }
});

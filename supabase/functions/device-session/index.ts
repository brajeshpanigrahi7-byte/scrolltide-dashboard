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
  let slot = Number(body.slot);

  if (!device) {
    return jsonResponse({ error: "Invalid device" }, 400, corsHeaders);
  }

  if (body.slot != null && (!Number.isInteger(slot) || slot < 1 || slot > 5)) {
    return jsonResponse({ error: "Invalid device or slot (1-5)" }, 400, corsHeaders);
  }

  try {
    const supabase = getSupabaseAdmin();
    const now = new Date();
    const nowIso = now.toISOString();
    const fifteenMinAgo = new Date(now.getTime() - 15 * 60 * 1000).toISOString();

    // 0. Auto-cleanup of stale / expired sessions in database
    try {
      // a) Expire pending sessions whose 10-min window elapsed
      await supabase
        .from("sessions")
        .update({ status: "expired" })
        .in("status", ["pending", "awaiting_payment"])
        .lte("expires_at", nowIso);

      // b) Complete active sessions whose end_time has passed
      await supabase
        .from("sessions")
        .update({ status: "completed", exit_signalled_at: nowIso })
        .eq("status", "active")
        .lte("end_time", nowIso);

      // c) Expire abandoned paid sessions older than 15 minutes where vehicle never entered
      await supabase
        .from("sessions")
        .update({ status: "expired" })
        .eq("status", "paid")
        .is("entered_at", null)
        .lte("created_at", fifteenMinAgo);
    } catch (cleanErr) {
      console.warn("Stale session auto-cleanup error:", cleanErr);
    }

    // Auto-assign first available slot if not specified
    if (!slot) {
      const { data: allSlots } = await supabase
        .from("slots")
        .select("slot, occupied")
        .order("slot", { ascending: true });

      const candidateSlots = (allSlots || [])
        .filter((s: any) => !s.occupied)
        .map((s: any) => s.slot);

      for (const cand of candidateSlots) {
        const { data: candSessions } = await supabase
          .from("sessions")
          .select("id, status, end_time, created_at, entered_at")
          .eq("slot", cand)
          .in("status", ["paid", "active"]);

        const isBlocked = (candSessions || []).some((s: any) => {
          if (s.status === "active") {
            return s.end_time && new Date(s.end_time).getTime() > now.getTime();
          }
          if (s.status === "paid") {
            const createdAt = s.created_at ? new Date(s.created_at).getTime() : 0;
            return !s.entered_at && now.getTime() - createdAt < 15 * 60 * 1000;
          }
          return false;
        });

        if (!isBlocked) {
          slot = cand;
          break;
        }
      }

      if (!slot) {
        return jsonResponse({ error: "No available parking slots" }, 409, corsHeaders);
      }
    }

    const publicAppUrl = (
      Deno.env.get("PUBLIC_APP_URL") || "https://scrolltide-dashboard.lovable.app"
    ).replace(/\/+$/, "");

    // 1. Check if slot is physically occupied in slots table
    const { data: slotRow, error: slotErr } = await supabase
      .from("slots")
      .select("occupied")
      .eq("slot", slot)
      .maybeSingle();

    if (slotErr) {
      console.warn("Could not query slots table:", slotErr.message);
    } else if (slotRow && slotRow.occupied) {
      return jsonResponse({ error: "Slot occupied", slot }, 409, corsHeaders);
    }

    // If slot is physically free, clean up any leftover active session whose time has ended
    if (slotRow && !slotRow.occupied) {
      try {
        await supabase
          .from("sessions")
          .update({ status: "completed", exit_signalled_at: nowIso })
          .eq("slot", slot)
          .eq("status", "active")
          .lte("end_time", nowIso);
      } catch {}
    }

    // 2. Safe Idempotency: Check if an unexpired session already exists for this device & slot
    // a) Existing unexpired pending session: return existing session without breaking QR code
    const { data: existingPending } = await supabase
      .from("sessions")
      .select("id, code, status, expires_at")
      .eq("device_id", device)
      .eq("slot", slot)
      .eq("status", "pending")
      .gt("expires_at", nowIso)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingPending) {
      let payUrl = `${publicAppUrl}/p/${existingPending.code}`;
      if (payUrl.length > 53) payUrl = `/p/${existingPending.code}`;
      return jsonResponse(
        {
          session_id: existingPending.id,
          code: existingPending.code,
          pay_url: payUrl,
        },
        200,
        corsHeaders,
      );
    }

    // b) Existing paid session awaiting entry for this device & slot
    const { data: existingPaid } = await supabase
      .from("sessions")
      .select("id, code, status, created_at, entered_at")
      .eq("device_id", device)
      .eq("slot", slot)
      .eq("status", "paid")
      .is("entered_at", null)
      .gt("created_at", fifteenMinAgo)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingPaid) {
      let payUrl = `${publicAppUrl}/p/${existingPaid.code}`;
      if (payUrl.length > 53) payUrl = `/p/${existingPaid.code}`;
      return jsonResponse(
        {
          session_id: existingPaid.id,
          code: existingPaid.code,
          status: "paid",
          pay_url: payUrl,
        },
        200,
        corsHeaders,
      );
    }

    // 3. Validate: slot has no currently active or paid session from another car
    const { data: existingSessions, error: sessErr } = await supabase
      .from("sessions")
      .select("id, status, end_time, created_at, entered_at, device_id")
      .eq("slot", slot)
      .in("status", ["paid", "active"]);

    if (sessErr) {
      console.warn("Error querying existing sessions:", sessErr.message);
    } else if (existingSessions && existingSessions.length > 0) {
      const activeBlocker = existingSessions.find((s: any) => {
        if (s.status === "active") {
          return s.end_time && new Date(s.end_time).getTime() > now.getTime();
        }
        if (s.status === "paid") {
          const createdAt = s.created_at ? new Date(s.created_at).getTime() : 0;
          return !s.entered_at && now.getTime() - createdAt < 15 * 60 * 1000;
        }
        return false;
      });

      if (activeBlocker) {
        return jsonResponse({ error: "Slot reserved", slot }, 409, corsHeaders);
      }
    }

    // 4. Expire any older pending session for this slot & device
    await supabase
      .from("sessions")
      .update({ status: "expired" })
      .eq("slot", slot)
      .in("status", ["pending", "awaiting_payment"]);

    await supabase
      .from("sessions")
      .update({ status: "expired" })
      .eq("device_id", device)
      .in("status", ["pending", "awaiting_payment"]);

    // 5. Generate unique 6-character code exclusively from "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
    // and insert into sessions, retrying up to 5 times on unique constraint collision
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    let newSession: { id: string; code: string } | null = null;
    let insertErr: any = null;

    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generateSessionCode(6);
      const { data: inserted, error: err } = await supabase
        .from("sessions")
        .insert({
          device_id: device,
          slot: slot,
          status: "pending",
          code: candidate,
          expires_at: expiresAt,
        })
        .select("id, code")
        .single();

      if (!err && inserted) {
        newSession = inserted;
        break;
      }

      insertErr = err;
      const msg = err?.message?.toLowerCase() || "";
      const isCollision =
        err?.code === "23505" ||
        msg.includes("unique") ||
        msg.includes("duplicate") ||
        msg.includes("collision");

      if (!isCollision) {
        break;
      }
    }

    if (!newSession) {
      return jsonResponse(
        { error: insertErr?.message || "Failed to create session after 5 attempts" },
        500,
        corsHeaders,
      );
    }

    // 6. Log session created to activity_logs
    try {
      await supabase.from("activity_logs").insert({
        device_id: device,
        type: "session_created",
        slot: slot,
        session_id: newSession.id,
        message: `Session ${newSession.code} created for slot ${slot}`,
      });
    } catch {}

    let payUrl = `${publicAppUrl}/p/${newSession.code}`;
    if (payUrl.length > 53) {
      payUrl = `/p/${newSession.code}`;
    }

    // Flat compact response: exactly {"session_id":"...","code":"...","pay_url":"..."}
    return jsonResponse(
      {
        session_id: newSession.id,
        code: newSession.code,
        pay_url: payUrl,
      },
      201,
      corsHeaders,
    );
  } catch (err: any) {
    console.error("Error in device-session function:", err);
    return jsonResponse({ error: err?.message || "Internal server error" }, 500, corsHeaders);
  }
});

import { z } from "zod";
import { sameSecret } from "./payment-security.server";

// Flat, compact JSON response helper for ESP32
function flatJson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function requireDeviceKey(request: Request): Response | null {
  const incoming = request.headers.get("x-device-key");
  const expected = process.env.DEVICE_API_KEY;
  if (!sameSecret(incoming, expected)) {
    return flatJson({ error: "Unauthorized" }, 401);
  }
  return null;
}

const CHARS = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
function generateCode(): string {
  let result = "";
  for (let i = 0; i < 6; i++) {
    result += CHARS[Math.floor(Math.random() * CHARS.length)];
  }
  return result;
}

let lastTelemetryCleanup = 0;

// ─── 1. POST /api/public/device-session ───
export async function deviceSession(request: Request): Promise<Response> {
  const denied = requireDeviceKey(request);
  if (denied) return denied;

  let body: { device?: string; slot?: number };
  try {
    body = await request.json();
  } catch {
    return flatJson({ error: "Invalid JSON" }, 400);
  }

  const device = typeof body.device === "string" ? body.device.trim() : "";
  const slot = Number(body.slot);

  if (!device || !slot || slot < 1 || slot > 5 || !Number.isInteger(slot)) {
    return flatJson({ error: "Need device and slot (1-5)" }, 400);
  }

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  // Validate: slot is not occupied in slots
  const { data: slotRow, error: slotErr } = await supabaseAdmin
    .from("slots")
    .select("occupied")
    .eq("slot", slot)
    .maybeSingle();

  if (slotErr) return flatJson({ error: slotErr.message }, 500);
  if (slotRow?.occupied) {
    return flatJson({ error: "Slot occupied" }, 409);
  }

  // Validate: slot has no active, paid, or unexpired pending session
  const { data: conflicts, error: confErr } = await supabaseAdmin
    .from("sessions")
    .select("id, status, expires_at")
    .eq("slot", slot)
    .in("status", ["pending", "paid", "active"]);

  if (confErr) return flatJson({ error: confErr.message }, 500);

  const now = new Date();
  const hasConflict = (conflicts || []).some((s) => {
    if (s.status === "paid" || s.status === "active") return true;
    if (s.status === "pending" && new Date(s.expires_at) > now) return true;
    return false;
  });

  if (hasConflict) {
    return flatJson({ error: "Slot reserved" }, 409);
  }

  // Cancel any older pending session of the same device
  await supabaseAdmin
    .from("sessions")
    .update({ status: "cancelled" })
    .eq("device_id", device)
    .eq("status", "pending");

  // Generate unique 6-char code
  let code = "";
  for (let i = 0; i < 5; i++) {
    const candidate = generateCode();
    const { data: existing } = await supabaseAdmin
      .from("sessions")
      .select("id")
      .eq("code", candidate)
      .maybeSingle();

    if (!existing) {
      code = candidate;
      break;
    }
  }

  if (!code) return flatJson({ error: "Could not generate code" }, 500);

  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

  // Create session
  const { data: newSession, error: createErr } = await supabaseAdmin
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

  if (createErr || !newSession) {
    return flatJson({ error: createErr?.message || "Failed to create session" }, 500);
  }

  // Log session created
  await supabaseAdmin.from("activity_logs").insert({
    device_id: device,
    type: "session_created",
    slot: slot,
    session_id: newSession.id,
    message: `Session ${code} created for slot ${slot}`,
  });

  const publicAppUrl = (process.env.PUBLIC_APP_URL || "https://scrolltide-dashboard.lovable.app").replace(/\/+$/, "");
  const payUrl = `${publicAppUrl}/p/${code}`;

  return flatJson(
    {
      session_id: newSession.id,
      code: newSession.code,
      pay_url: payUrl,
    },
    201
  );
}

// ─── 2. GET /api/public/device-poll?session=<uuid> ───
export async function devicePoll(request: Request): Promise<Response> {
  const denied = requireDeviceKey(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const sessionId = url.searchParams.get("session")?.trim();

  if (!sessionId) return flatJson({ error: "Missing session parameter" }, 400);

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data: session, error } = await supabaseAdmin
    .from("sessions")
    .select("id, status, duration_min, expires_at")
    .eq("id", sessionId)
    .maybeSingle();

  if (error || !session) return flatJson({ error: "Session not found" }, 404);

  let status = session.status;
  const durationMin = session.duration_min || 0;

  if (status === "pending") {
    const expiresAt = new Date(session.expires_at).getTime();
    if (Date.now() > expiresAt) {
      status = "expired";
      await supabaseAdmin.from("sessions").update({ status: "expired" }).eq("id", sessionId);
      await supabaseAdmin.from("activity_logs").insert({
        type: "session_expired",
        session_id: sessionId,
        message: `Session ${sessionId} expired`,
      });
    }
  }

  let reportedStatus = status;
  if (status === "paid" || status === "active") {
    reportedStatus = "paid";
  }

  return flatJson(
    {
      status: reportedStatus,
      duration_min: reportedStatus === "paid" ? durationMin : 0,
    },
    200
  );
}

// ─── 3. POST /api/public/device-event ───
export async function deviceEvent(request: Request): Promise<Response> {
  const denied = requireDeviceKey(request);
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return flatJson({ error: "Invalid JSON" }, 400);
  }

  const device = typeof body.device === "string" ? body.device.trim() : null;
  const event = typeof body.event === "string" ? body.event.trim() : null;

  if (!device || !event) {
    return flatJson({ error: "Missing device or event" }, 400);
  }

  const session = typeof body.session === "string" ? body.session.trim() : null;
  const slot = typeof body.slot === "number" ? body.slot : null;
  const occupancy = typeof body.occupancy === "string" && /^[01]{5}$/.test(body.occupancy) ? body.occupancy : null;

  const state = typeof body.state === "number" ? body.state : null;
  const dist = typeof body.dist === "number" ? body.dist : null;
  const rssi = typeof body.rssi === "number" ? body.rssi : null;
  const uptime = typeof body.uptime === "number" ? body.uptime : null;
  const exitOpen = typeof body.exit_open === "boolean" ? body.exit_open : null;

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const now = new Date();
  const nowIso = now.toISOString();

  // Upsert devices table
  const deviceUpdate: Record<string, unknown> = {
    id: device,
    last_seen: nowIso,
  };
  if (rssi !== null) deviceUpdate.rssi = rssi;
  if (uptime !== null) deviceUpdate.uptime_s = uptime;
  if (state !== null) deviceUpdate.entry_state = state;
  if (exitOpen !== null) deviceUpdate.exit_open = exitOpen;
  if (event === "boot") deviceUpdate.boot_at = nowIso;

  await supabaseAdmin.from("devices").upsert(deviceUpdate, { onConflict: "id" });

  // Update slots from occupancy
  if (occupancy) {
    const { data: currentSlots } = await supabaseAdmin
      .from("slots")
      .select("slot, occupied")
      .order("slot", { ascending: true });

    const currentMap = new Map((currentSlots || []).map((s: any) => [s.slot, s.occupied]));

    for (let i = 0; i < 5; i++) {
      const slotNum = i + 1;
      const isOccupied = occupancy[i] === "1";
      const wasOccupied = currentMap.get(slotNum);

      if (wasOccupied !== isOccupied) {
        await supabaseAdmin.from("slots").upsert(
          {
            slot: slotNum,
            occupied: isOccupied,
            updated_at: nowIso,
          },
          { onConflict: "slot" }
        );

        await supabaseAdmin.from("activity_logs").insert({
          device_id: device,
          type: "slot_change",
          slot: slotNum,
          message: `Slot ${slotNum} is now ${isOccupied ? "occupied" : "free"}`,
        });
      }
    }
  }

  // Insert device_telemetry
  await supabaseAdmin.from("device_telemetry").insert({
    device_id: device,
    dist_cm: dist,
    rssi: rssi,
    occupancy: occupancy,
    entry_state: state,
    ts: nowIso,
  });

  if (Date.now() - lastTelemetryCleanup > 60_000) {
    lastTelemetryCleanup = Date.now();
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await supabaseAdmin.from("device_telemetry").delete().lt("ts", dayAgo);
  }

  // Event handlers
  if (event === "boot") {
    await supabaseAdmin.from("activity_logs").insert({
      device_id: device,
      type: "boot",
      message: "ESP32 powered on",
    });
  } else if (event === "entered") {
    if (session) {
      const { data: sess } = await supabaseAdmin
        .from("sessions")
        .select("id, duration_min, slot")
        .eq("id", session)
        .maybeSingle();

      if (sess) {
        const durationMin = sess.duration_min || 30;
        const endTime = new Date(now.getTime() + durationMin * 60 * 1000).toISOString();

        await supabaseAdmin
          .from("sessions")
          .update({
            status: "active",
            entered_at: nowIso,
            start_time: nowIso,
            end_time: endTime,
          })
          .eq("id", session);

        await supabaseAdmin.from("activity_logs").insert({
          device_id: device,
          type: "entered",
          slot: sess.slot,
          session_id: session,
          message: `Vehicle entered slot ${sess.slot}`,
        });
      }
    }
  } else if (event === "cancelled") {
    if (session) {
      await supabaseAdmin
        .from("sessions")
        .update({ status: "cancelled" })
        .eq("id", session)
        .eq("status", "pending");

      await supabaseAdmin.from("activity_logs").insert({
        device_id: device,
        type: "cancelled",
        session_id: session,
        message: "Session cancelled",
      });
    }
  }

  // 3-minute fallback for paid sessions without entered
  const threeMinAgo = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  const { data: stalePaid } = await supabaseAdmin
    .from("sessions")
    .select("id, duration_min, slot")
    .eq("status", "paid")
    .is("entered_at", null)
    .lte("paid_at", threeMinAgo);

  if (stalePaid && stalePaid.length > 0) {
    for (const st of stalePaid) {
      const durationMin = st.duration_min || 30;
      const endTime = new Date(now.getTime() + durationMin * 60 * 1000).toISOString();
      await supabaseAdmin
        .from("sessions")
        .update({
          status: "active",
          entered_at: nowIso,
          start_time: nowIso,
          end_time: endTime,
        })
        .eq("id", st.id);

      await supabaseAdmin.from("activity_logs").insert({
        device_id: device,
        type: "entered",
        slot: st.slot,
        session_id: st.id,
        message: `Auto-started timer for slot ${st.slot} after 3 min fallback`,
      });
    }
  }

  return flatJson({ ok: true }, 200);
}

// ─── 4. GET /api/public/device-due?device=esp32-entry-1 ───
export async function deviceDue(request: Request): Promise<Response> {
  const denied = requireDeviceKey(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const device = url.searchParams.get("device")?.trim() || "esp32-entry-1";

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const now = new Date();
  const nowIso = now.toISOString();

  const { data: settings } = await supabaseAdmin
    .from("settings")
    .select("reminder_min")
    .eq("id", 1)
    .maybeSingle();

  const reminderMin = settings?.reminder_min || 10;
  let exitOpen = false;

  // Check ended active sessions
  const { data: expiredSessions } = await supabaseAdmin
    .from("sessions")
    .select("id, slot")
    .eq("status", "active")
    .is("exit_signalled_at", null)
    .lte("end_time", nowIso);

  if (expiredSessions && expiredSessions.length > 0) {
    for (const exp of expiredSessions) {
      const { data: updated } = await supabaseAdmin
        .from("sessions")
        .update({
          status: "completed",
          exit_signalled_at: nowIso,
        })
        .eq("id", exp.id)
        .is("exit_signalled_at", null)
        .select("id")
        .maybeSingle();

      if (updated) {
        exitOpen = true;
        await supabaseAdmin.from("activity_logs").insert({
          device_id: device,
          type: "exit_opened",
          slot: exp.slot,
          session_id: exp.id,
          message: `Exit gate signalled for slot ${exp.slot} (time over)`,
        });
      }
    }
  }

  // Check device_commands for unconsumed open_exit
  const { data: commands } = await supabaseAdmin
    .from("device_commands")
    .select("id")
    .eq("command", "open_exit")
    .is("consumed_at", null)
    .order("created_at", { ascending: true })
    .limit(1);

  if (commands && commands.length > 0) {
    const { data: consumed } = await supabaseAdmin
      .from("device_commands")
      .update({ consumed_at: nowIso })
      .eq("id", commands[0].id)
      .is("consumed_at", null)
      .select("id")
      .maybeSingle();

    if (consumed) {
      exitOpen = true;
      await supabaseAdmin.from("activity_logs").insert({
        device_id: device,
        type: "exit_opened",
        message: "Exit gate signalled via admin command",
      });
    }
  }

  if (exitOpen) {
    await supabaseAdmin.from("devices").update({ exit_open: true }).eq("id", device);
  }

  // Check warn_slots
  const reminderThreshold = new Date(now.getTime() + reminderMin * 60 * 1000).toISOString();
  const { data: warnSessions } = await supabaseAdmin
    .from("sessions")
    .select("id, slot, contact_email, reminder_sent")
    .eq("status", "active")
    .gt("end_time", nowIso)
    .lte("end_time", reminderThreshold);

  const warnSlotsSet = new Set<number>();
  if (warnSessions) {
    for (const ws of warnSessions) {
      if (ws.slot >= 1 && ws.slot <= 5) {
        warnSlotsSet.add(ws.slot);
      }
      if (!ws.reminder_sent) {
        await supabaseAdmin.from("sessions").update({ reminder_sent: true }).eq("id", ws.id);
        await supabaseAdmin.from("activity_logs").insert({
          device_id: device,
          type: "reminder_sent",
          slot: ws.slot,
          session_id: ws.id,
          message: `${reminderMin}-minute reminder for slot ${ws.slot}`,
        });
      }
    }
  }

  const warnSlots = Array.from(warnSlotsSet).sort((a, b) => a - b);

  return flatJson(
    {
      exit_open: exitOpen,
      warn_slots: warnSlots,
    },
    200
  );
}

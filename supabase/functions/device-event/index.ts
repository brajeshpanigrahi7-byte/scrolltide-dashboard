import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { constantTimeCompare } from "../_shared/crypto.ts";
import { getSupabaseAdmin } from "../_shared/supabase.ts";
import { jsonResponse } from "../_shared/utils.ts";

let lastTelemetryCleanup = 0;

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

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400, corsHeaders);
  }

  const device = typeof body.device === "string" ? body.device.trim() : null;
  const event = typeof body.event === "string" ? body.event.trim() : null;

  if (!device || !event) {
    return jsonResponse({ error: "Missing required fields: device and event" }, 400, corsHeaders);
  }

  const session = typeof body.session === "string" ? body.session.trim() : null;
  const slot = typeof body.slot === "number" ? body.slot : null;
  const occupancy = typeof body.occupancy === "string" && /^[01]{5}$/.test(body.occupancy) ? body.occupancy : null;

  const state = typeof body.state === "number" ? body.state : null;
  const dist = typeof body.dist === "number" ? body.dist : null;
  const rssi = typeof body.rssi === "number" ? body.rssi : null;
  const uptime = typeof body.uptime === "number" ? body.uptime : null;
  const exitOpen = typeof body.exit_open === "boolean" ? body.exit_open : null;

  const supabase = getSupabaseAdmin();
  const now = new Date();
  const nowIso = now.toISOString();

  // 1. Upsert devices table
  const deviceUpdate: Record<string, unknown> = {
    id: device,
    last_seen: nowIso,
  };
  if (rssi !== null) deviceUpdate.rssi = rssi;
  if (uptime !== null) deviceUpdate.uptime_s = uptime;
  if (state !== null) deviceUpdate.entry_state = state;
  if (exitOpen !== null) deviceUpdate.exit_open = exitOpen;
  if (event === "boot") deviceUpdate.boot_at = nowIso;

  await supabase.from("devices").upsert(deviceUpdate, { onConflict: "id" });

  // 2. Update slots from occupancy if provided
  if (occupancy) {
    const { data: currentSlots } = await supabase
      .from("slots")
      .select("slot, occupied")
      .order("slot", { ascending: true });

    const currentMap = new Map((currentSlots || []).map((s) => [s.slot, s.occupied]));

    for (let i = 0; i < 5; i++) {
      const slotNum = i + 1;
      const isOccupied = occupancy[i] === "1";
      const wasOccupied = currentMap.get(slotNum);

      if (wasOccupied !== isOccupied) {
        await supabase
          .from("slots")
          .upsert({
            slot: slotNum,
            occupied: isOccupied,
            updated_at: nowIso,
          }, { onConflict: "slot" });

        // When a slot changes from occupied (1) to free (0), release any active session
        if (wasOccupied && !isOccupied) {
          try {
            await supabase
              .from("sessions")
              .update({
                status: "completed",
                exit_signalled_at: nowIso,
              })
              .eq("slot", slotNum)
              .eq("status", "active");

            await supabase.from("activity_logs").insert({
              device_id: device,
              type: "slot_freed",
              slot: slotNum,
              message: `Vehicle exited slot ${slotNum}. Slot is now free.`,
            });
          } catch (sessErr) {
            console.warn(`Could not mark slot ${slotNum} session completed:`, sessErr);
          }
        } else {
          await supabase.from("activity_logs").insert({
            device_id: device,
            type: "slot_change",
            slot: slotNum,
            message: `Slot ${slotNum} is now ${isOccupied ? "occupied" : "free"}`,
          });
        }
      }
    }
  }

  // 3. Insert device_telemetry row
  await supabase.from("device_telemetry").insert({
    device_id: device,
    dist_cm: dist,
    rssi: rssi,
    occupancy: occupancy,
    entry_state: state,
    ts: nowIso,
  });

  // Telemetry cleanup (older than 24 hours, at most once per minute)
  if (Date.now() - lastTelemetryCleanup > 60_000) {
    lastTelemetryCleanup = Date.now();
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await supabase.from("device_telemetry").delete().lt("ts", dayAgo);
  }

  // 4. Handle specific events
  if (event === "boot") {
    await supabase.from("activity_logs").insert({
      device_id: device,
      type: "boot",
      message: "ESP32 powered on",
    });
  } else if (event === "entered") {
    // If session ID given, activate it
    if (session) {
      const { data: sess } = await supabase
        .from("sessions")
        .select("id, duration_min, slot, status")
        .eq("id", session)
        .maybeSingle();

      if (sess) {
        const durationMin = sess.duration_min || 30;
        const endTime = new Date(now.getTime() + durationMin * 60 * 1000).toISOString();

        await supabase
          .from("sessions")
          .update({
            status: "active",
            entered_at: nowIso,
            start_time: nowIso,
            end_time: endTime,
          })
          .eq("id", session);

        await supabase.from("activity_logs").insert({
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
      await supabase
        .from("sessions")
        .update({ status: "cancelled" })
        .eq("id", session)
        .eq("status", "pending");

      await supabase.from("activity_logs").insert({
        device_id: device,
        type: "cancelled",
        session_id: session,
        message: "Session cancelled",
      });
    }
  }

  // Fallback check: Paid sessions without 'entered' after 3 minutes -> automatically start timer
  const threeMinAgo = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  const { data: stalePaidSessions } = await supabase
    .from("sessions")
    .select("id, duration_min, slot")
    .eq("status", "paid")
    .is("entered_at", null)
    .lte("paid_at", threeMinAgo);

  if (stalePaidSessions && stalePaidSessions.length > 0) {
    for (const st of stalePaidSessions) {
      const durationMin = st.duration_min || 30;
      const endTime = new Date(now.getTime() + durationMin * 60 * 1000).toISOString();
      await supabase
        .from("sessions")
        .update({
          status: "active",
          entered_at: nowIso,
          start_time: nowIso,
          end_time: endTime,
        })
        .eq("id", st.id);

      await supabase.from("activity_logs").insert({
        device_id: device,
        type: "entered",
        slot: st.slot,
        session_id: st.id,
        message: `Auto-started timer for slot ${st.slot} after 3 min fallback`,
      });
    }
  }

  return jsonResponse({ ok: true }, 200, corsHeaders);
});

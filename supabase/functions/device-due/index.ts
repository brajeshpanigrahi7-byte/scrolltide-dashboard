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

  try {
    const url = new URL(req.url);
    const device = url.searchParams.get("device")?.trim() || "esp32-entry-1";

    const supabase = getSupabaseAdmin();
    const now = new Date();
    const nowIso = now.toISOString();

    // 1. Fetch settings for reminder_min
    let reminderMin = 10;
    try {
      const { data: settings } = await supabase
        .from("settings")
        .select("reminder_min, exit_open_seconds")
        .eq("id", 1)
        .maybeSingle();

      if (settings?.reminder_min) {
        reminderMin = Number(settings.reminder_min);
      }
    } catch (e) {
      console.warn("Could not load settings:", e);
    }

    // 2. Check if exit gate needs to open for expired active sessions
    let exitOpen = false;

    try {
      const { data: expiredSessions, error: expErr } = await supabase
        .from("sessions")
        .select("id, slot, exit_signalled_at")
        .eq("status", "active")
        .lte("end_time", nowIso);

      if (!expErr && expiredSessions && Array.isArray(expiredSessions) && expiredSessions.length > 0) {
        for (const exp of expiredSessions) {
          const shouldSignalExit = !exp.exit_signalled_at;
          await supabase
            .from("sessions")
            .update({
              status: "completed",
              ...(shouldSignalExit ? { exit_signalled_at: nowIso } : {}),
            })
            .eq("id", exp.id);

          if (shouldSignalExit) {
            exitOpen = true;
            try {
              await supabase.from("activity_logs").insert({
                device_id: device,
                type: "exit_opened",
                slot: exp.slot,
                session_id: exp.id,
                message: `Exit gate signalled for slot ${exp.slot} (time over)`,
              });
            } catch {}
          }
        }
      }
    } catch (e) {
      console.warn("Error checking expired sessions:", e);
    }

    // 3. Also check for manual open_exit commands in device_commands
    try {
      const { data: commands, error: cmdErr } = await supabase
        .from("device_commands")
        .select("id")
        .eq("command", "open_exit")
        .is("consumed_at", null)
        .order("created_at", { ascending: true })
        .limit(1);

      if (!cmdErr && commands && Array.isArray(commands) && commands.length > 0) {
        const cmdId = commands[0].id;
        const { data: consumed } = await supabase
          .from("device_commands")
          .update({ consumed_at: nowIso })
          .eq("id", cmdId)
          .is("consumed_at", null)
          .select("id")
          .maybeSingle();

        if (consumed) {
          exitOpen = true;
          try {
            await supabase.from("activity_logs").insert({
              device_id: device,
              type: "exit_opened",
              message: "Exit gate signalled via admin command",
            });
          } catch {}
        }
      }
    } catch (e) {
      console.warn("Error checking commands:", e);
    }

    // Update devices.exit_open
    if (exitOpen) {
      try {
        await supabase.from("devices").upsert({ id: device, exit_open: true }, { onConflict: "id" });
      } catch (e) {
        console.warn("Error updating devices exit_open:", e);
      }
    }

    // 4. Find warn_slots: slots (1-5) of active sessions with end_time within reminder_min minutes
    const warnSlotsSet = new Set<number>();
    try {
      const reminderThreshold = new Date(now.getTime() + reminderMin * 60 * 1000).toISOString();
      const { data: warnSessions, error: warnErr } = await supabase
        .from("sessions")
        .select("id, slot, contact_email, reminder_sent, end_time")
        .eq("status", "active")
        .gt("end_time", nowIso)
        .lte("end_time", reminderThreshold);

      if (!warnErr && warnSessions && Array.isArray(warnSessions)) {
        for (const ws of warnSessions) {
          if (ws.slot >= 1 && ws.slot <= 5) {
            warnSlotsSet.add(ws.slot);
          }

          if (!ws.reminder_sent) {
            await supabase
              .from("sessions")
              .update({ reminder_sent: true })
              .eq("id", ws.id);

            try {
              await supabase.from("activity_logs").insert({
                device_id: device,
                type: "reminder_sent",
                slot: ws.slot,
                session_id: ws.id,
                message: `${reminderMin}-minute reminder for slot ${ws.slot}`,
              });
            } catch {}
          }
        }
      }
    } catch (e) {
      console.warn("Error checking warn_slots:", e);
    }

    const warnSlots = Array.from(warnSlotsSet).sort((a, b) => a - b);

    // Flat compact response: exactly {"exit_open":false,"warn_slots":[]}
    return jsonResponse(
      {
        exit_open: exitOpen,
        warn_slots: warnSlots,
      },
      200,
      corsHeaders
    );
  } catch (err) {
    console.error("Critical error in device-due:", err);
    return jsonResponse(
      {
        exit_open: false,
        warn_slots: [],
      },
      200,
      corsHeaders
    );
  }
});

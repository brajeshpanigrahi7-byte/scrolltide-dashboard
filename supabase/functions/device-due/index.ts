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
  const device = url.searchParams.get("device")?.trim() || "esp32-entry-1";

  const supabase = getSupabaseAdmin();
  const now = new Date();
  const nowIso = now.toISOString();

  // 1. Fetch settings for reminder_min
  const { data: settings } = await supabase
    .from("settings")
    .select("reminder_min, exit_open_seconds")
    .eq("id", 1)
    .maybeSingle();

  const reminderMin = settings?.reminder_min || 10;

  // 2. Check if exit gate needs to open for expired active sessions
  // Atomically update exit_signalled_at = now, status = 'completed' where exit_signalled_at is null, status = 'active', and end_time <= now
  let exitOpen = false;

  const { data: expiredSessions } = await supabase
    .from("sessions")
    .select("id, slot")
    .eq("status", "active")
    .is("exit_signalled_at", null)
    .lte("end_time", nowIso);

  if (expiredSessions && expiredSessions.length > 0) {
    for (const exp of expiredSessions) {
      const { data: updated } = await supabase
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
        await supabase.from("activity_logs").insert({
          device_id: device,
          type: "exit_opened",
          slot: exp.slot,
          session_id: exp.id,
          message: `Exit gate signalled for slot ${exp.slot} (time over)`,
        });
      }
    }
  }

  // 3. Also check for manual open_exit commands in device_commands
  const { data: commands } = await supabase
    .from("device_commands")
    .select("id")
    .eq("command", "open_exit")
    .is("consumed_at", null)
    .order("created_at", { ascending: true })
    .limit(1);

  if (commands && commands.length > 0) {
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
      await supabase.from("activity_logs").insert({
        device_id: device,
        type: "exit_opened",
        message: "Exit gate signalled via admin command",
      });
    }
  }

  // Update devices.exit_open
  if (exitOpen) {
    await supabase.from("devices").update({ exit_open: true }).eq("id", device);
  }

  // 4. Find warn_slots: slots (1-5) of active sessions with end_time within reminder_min minutes and still in the future
  const reminderThreshold = new Date(now.getTime() + reminderMin * 60 * 1000).toISOString();
  const { data: warnSessions } = await supabase
    .from("sessions")
    .select("id, slot, contact_email, reminder_sent, end_time")
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
        await supabase
          .from("sessions")
          .update({ reminder_sent: true })
          .eq("id", ws.id);

        await supabase.from("activity_logs").insert({
          device_id: device,
          type: "reminder_sent",
          slot: ws.slot,
          session_id: ws.id,
          message: `${reminderMin}-minute reminder for slot ${ws.slot}`,
        });

        // Email reminder if contact_email is available (placeholder log/call)
        if (ws.contact_email) {
          console.log(`[Reminder] Send email to ${ws.contact_email} for slot ${ws.slot}`);
        }
      }
    }
  }

  const warnSlots = Array.from(warnSlotsSet).sort((a, b) => a - b);

  // Flat compact response: exactly {"exit_open":false,"warn_slots":[1,3]}
  return jsonResponse(
    {
      exit_open: exitOpen,
      warn_slots: warnSlots,
    },
    200,
    corsHeaders
  );
});

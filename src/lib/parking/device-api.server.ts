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

let cachedDb: any = null;

async function getDbClient(): Promise<any> {
  if (cachedDb) return cachedDb;

  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    if (supabaseAdmin && typeof (supabaseAdmin as any).from === "function") {
      cachedDb = supabaseAdmin;
      return cachedDb;
    }
  } catch (err) {
    // Expected fallback when SUPABASE_SERVICE_ROLE_KEY is not configured in server env
  }

  const { createClient } = await import("@supabase/supabase-js");
  const url =
    process.env.SUPABASE_URL ||
    process.env.VITE_SUPABASE_URL ||
    "https://c--ed7c000c-2305-4d18-af24-04a5934fd53f-prod.lovable.cloud";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    "sb_publishable_kPuwTUf21eT3IZzI21t0MQ_wuq5gxNg";

  cachedDb = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return cachedDb;
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

  try {
    const db = await getDbClient();

    // 1. Validate: slot is not physically occupied in slots table
    const { data: slotRow, error: slotErr } = await db
      .from("slots")
      .select("occupied")
      .eq("slot", slot)
      .maybeSingle();

    if (slotErr) {
      console.warn("Could not verify slots table, proceeding:", slotErr.message);
    } else if (slotRow?.occupied) {
      return flatJson({ error: "Slot occupied" }, 409);
    }

    // 2. Validate: slot has no currently active or paid session
    // Pending and expired sessions do NOT block session creation
    const { data: activeSessions, error: confErr } = await db
      .from("sessions")
      .select("id, status")
      .eq("slot", slot)
      .in("status", ["paid", "active"]);

    if (confErr) {
      console.warn("Error querying active sessions:", confErr.message);
    } else if (activeSessions && activeSessions.length > 0) {
      return flatJson({ error: "Slot reserved" }, 409);
    }

    // 3. Expire any existing pending/awaiting_payment sessions for this slot
    await db
      .from("sessions")
      .update({ status: "expired" })
      .eq("slot", slot)
      .in("status", ["pending", "awaiting_payment"]);

    // Also expire any older pending sessions of the same device
    await db
      .from("sessions")
      .update({ status: "expired" })
      .eq("device_id", device)
      .in("status", ["pending", "awaiting_payment"]);

    // 4. Generate unique 6-character code
    let code = "";
    for (let i = 0; i < 5; i++) {
      const candidate = generateCode();
      const { data: existing } = await db
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

    // 10-minute expiry for awaiting_payment sessions
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    // 5. Create new session with pending status
    const { data: newSession, error: createErr } = await db
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

    // 6. Log session created
    try {
      await db.from("activity_logs").insert({
        device_id: device,
        type: "session_created",
        slot: slot,
        session_id: newSession.id,
        message: `Session ${code} created for slot ${slot}`,
      });
    } catch (e) {
      console.warn("Could not write to activity_logs:", e);
    }

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
  } catch (err: any) {
    console.error("Error in deviceSession:", err);
    return flatJson({ error: err?.message || "Internal server error" }, 500);
  }
}

// ─── 2. GET /api/public/device-poll?session=<uuid> ───
export async function devicePoll(request: Request): Promise<Response> {
  const denied = requireDeviceKey(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const sessionId = url.searchParams.get("session")?.trim();

  if (!sessionId) return flatJson({ error: "Missing session parameter" }, 400);

  try {
    const db = await getDbClient();

    const { data: session, error } = await db
      .from("sessions")
      .select("id, status, duration_min, expires_at")
      .eq("id", sessionId)
      .maybeSingle();

    if (error || !session) return flatJson({ error: "Session not found" }, 404);

    let status = session.status;
    const durationMin = session.duration_min || 0;

    if (status === "pending" || status === "awaiting_payment") {
      const expiresAt = session.expires_at ? new Date(session.expires_at).getTime() : 0;
      if (expiresAt && Date.now() > expiresAt) {
        status = "expired";
        await db.from("sessions").update({ status: "expired" }).eq("id", sessionId);
        try {
          await db.from("activity_logs").insert({
            type: "session_expired",
            session_id: sessionId,
            message: `Session ${sessionId} expired`,
          });
        } catch {}
      }
    }

    let reportedStatus = status;
    if (status === "paid" || status === "active") {
      reportedStatus = "paid";
    } else if (status === "awaiting_payment") {
      reportedStatus = "pending";
    }

    return flatJson(
      {
        status: reportedStatus,
        duration_min: reportedStatus === "paid" ? durationMin : 0,
      },
      200
    );
  } catch (err: any) {
    console.error("Error in devicePoll:", err);
    return flatJson({ error: err?.message || "Internal server error" }, 500);
  }
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

  try {
    const session = typeof body.session === "string" ? body.session.trim() : null;
    const slot = typeof body.slot === "number" ? body.slot : null;
    const occupancy = typeof body.occupancy === "string" && /^[01]{5}$/.test(body.occupancy) ? body.occupancy : null;

    const state = typeof body.state === "number" ? body.state : null;
    const dist = typeof body.dist === "number" ? body.dist : null;
    const rssi = typeof body.rssi === "number" ? body.rssi : null;
    const uptime = typeof body.uptime === "number" ? body.uptime : null;
    const exitOpen = typeof body.exit_open === "boolean" ? body.exit_open : null;

    const db = await getDbClient();
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

    try {
      await db.from("devices").upsert(deviceUpdate, { onConflict: "id" });
    } catch (e) {
      console.warn("Could not upsert devices row:", e);
    }

    // Update slots from occupancy
    if (occupancy) {
      try {
        const { data: currentSlots } = await db
          .from("slots")
          .select("slot, occupied")
          .order("slot", { ascending: true });

        const currentMap = new Map((currentSlots || []).map((s: any) => [s.slot, s.occupied]));

        for (let i = 0; i < 5; i++) {
          const slotNum = i + 1;
          const isOccupied = occupancy[i] === "1";
          const wasOccupied = currentMap.get(slotNum);

          if (wasOccupied !== isOccupied) {
            await db.from("slots").upsert(
              {
                slot: slotNum,
                occupied: isOccupied,
                updated_at: nowIso,
              },
              { onConflict: "slot" }
            );

            await db.from("activity_logs").insert({
              device_id: device,
              type: "slot_change",
              slot: slotNum,
              message: `Slot ${slotNum} is now ${isOccupied ? "occupied" : "free"}`,
            });
          }
        }
      } catch (e) {
        console.warn("Could not update slots from occupancy:", e);
      }
    }

    // Insert device_telemetry
    try {
      await db.from("device_telemetry").insert({
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
        await db.from("device_telemetry").delete().lt("ts", dayAgo);
      }
    } catch (e) {
      console.warn("Could not insert device_telemetry:", e);
    }

    // Event handlers
    if (event === "boot") {
      try {
        await db.from("activity_logs").insert({
          device_id: device,
          type: "boot",
          message: "ESP32 powered on",
        });
      } catch {}
    } else if (event === "entered") {
      if (session) {
        try {
          const { data: sess } = await db
            .from("sessions")
            .select("id, duration_min, slot")
            .eq("id", session)
            .maybeSingle();

          if (sess) {
            const durationMin = sess.duration_min || 30;
            const endTime = new Date(now.getTime() + durationMin * 60 * 1000).toISOString();

            await db
              .from("sessions")
              .update({
                status: "active",
                entered_at: nowIso,
                start_time: nowIso,
                end_time: endTime,
              })
              .eq("id", session);

            await db.from("activity_logs").insert({
              device_id: device,
              type: "entered",
              slot: sess.slot,
              session_id: session,
              message: `Vehicle entered slot ${sess.slot}`,
            });
          }
        } catch (e) {
          console.warn("Could not handle entered event:", e);
        }
      }
    } else if (event === "cancelled") {
      if (session) {
        try {
          await db
            .from("sessions")
            .update({ status: "cancelled" })
            .eq("id", session)
            .eq("status", "pending");

          await db.from("activity_logs").insert({
            device_id: device,
            type: "cancelled",
            session_id: session,
            message: "Session cancelled",
          });
        } catch (e) {
          console.warn("Could not handle cancelled event:", e);
        }
      }
    }

    // 3-minute fallback for paid sessions without entered
    try {
      const threeMinAgo = new Date(Date.now() - 3 * 60 * 1000).toISOString();
      const { data: stalePaid } = await db
        .from("sessions")
        .select("id, duration_min, slot")
        .eq("status", "paid")
        .is("entered_at", null)
        .lte("paid_at", threeMinAgo);

      if (stalePaid && stalePaid.length > 0) {
        for (const st of stalePaid) {
          const durationMin = st.duration_min || 30;
          const endTime = new Date(now.getTime() + durationMin * 60 * 1000).toISOString();
          await db
            .from("sessions")
            .update({
              status: "active",
              entered_at: nowIso,
              start_time: nowIso,
              end_time: endTime,
            })
            .eq("id", st.id);

          await db.from("activity_logs").insert({
            device_id: device,
            type: "entered",
            slot: st.slot,
            session_id: st.id,
            message: `Auto-started timer for slot ${st.slot} after 3 min fallback`,
          });
        }
      }
    } catch (e) {
      console.warn("Could not run 3-min fallback check:", e);
    }

    return flatJson({ ok: true }, 200);
  } catch (err: any) {
    console.error("Error in deviceEvent:", err);
    return flatJson({ error: err?.message || "Internal server error" }, 500);
  }
}

// ─── 4. GET /api/public/device-due?device=esp32-entry-1 ───
export async function deviceDue(request: Request): Promise<Response> {
  const denied = requireDeviceKey(request);
  if (denied) return denied;

  try {
    const url = new URL(request.url);
    const device = url.searchParams.get("device")?.trim() || "esp32-entry-1";

    const db = await getDbClient();
    const now = new Date();
    const nowIso = now.toISOString();

    let reminderMin = 10;
    try {
      const { data: settings } = await db
        .from("settings")
        .select("reminder_min")
        .eq("id", 1)
        .maybeSingle();

      if (settings?.reminder_min) {
        reminderMin = Number(settings.reminder_min);
      }
    } catch (e) {
      console.warn("Could not load settings in deviceDue:", e);
    }

    let exitOpen = false;

    // Check ended active sessions (end_time <= now and exit not yet signalled)
    try {
      const { data: expiredSessions, error: expErr } = await db
        .from("sessions")
        .select("id, slot")
        .eq("status", "active")
        .is("exit_signalled_at", null)
        .lte("end_time", nowIso);

      if (!expErr && expiredSessions && Array.isArray(expiredSessions) && expiredSessions.length > 0) {
        for (const exp of expiredSessions) {
          const { data: updated } = await db
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
            try {
              await db.from("activity_logs").insert({
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
      console.warn("Error checking expired sessions in deviceDue:", e);
    }

    // Check device_commands for unconsumed open_exit
    try {
      const { data: commands, error: cmdErr } = await db
        .from("device_commands")
        .select("id")
        .eq("command", "open_exit")
        .is("consumed_at", null)
        .order("created_at", { ascending: true })
        .limit(1);

      if (!cmdErr && commands && Array.isArray(commands) && commands.length > 0) {
        const { data: consumed } = await db
          .from("device_commands")
          .update({ consumed_at: nowIso })
          .eq("id", commands[0].id)
          .is("consumed_at", null)
          .select("id")
          .maybeSingle();

        if (consumed) {
          exitOpen = true;
          try {
            await db.from("activity_logs").insert({
              device_id: device,
              type: "exit_opened",
              message: "Exit gate signalled via admin command",
            });
          } catch {}
        }
      }
    } catch (e) {
      console.warn("Error checking device_commands in deviceDue:", e);
    }

    if (exitOpen) {
      try {
        await db.from("devices").upsert({ id: device, exit_open: true }, { onConflict: "id" });
      } catch (e) {
        console.warn("Error updating devices in deviceDue:", e);
      }
    }

    // Check warn_slots: slots of active sessions ending within reminder window
    const warnSlotsSet = new Set<number>();
    try {
      const reminderThreshold = new Date(now.getTime() + reminderMin * 60 * 1000).toISOString();
      const { data: warnSessions, error: warnErr } = await db
        .from("sessions")
        .select("id, slot, contact_email, reminder_sent")
        .eq("status", "active")
        .gt("end_time", nowIso)
        .lte("end_time", reminderThreshold);

      if (!warnErr && warnSessions && Array.isArray(warnSessions)) {
        for (const ws of warnSessions) {
          if (ws.slot >= 1 && ws.slot <= 5) {
            warnSlotsSet.add(ws.slot);
          }
          if (!ws.reminder_sent) {
            await db.from("sessions").update({ reminder_sent: true }).eq("id", ws.id);
            try {
              await db.from("activity_logs").insert({
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
      console.warn("Error checking warn_slots in deviceDue:", e);
    }

    const warnSlots = Array.from(warnSlotsSet).sort((a, b) => a - b);

    // Guaranteed flat 200 JSON: {"exit_open":false,"warn_slots":[]}
    return flatJson(
      {
        exit_open: exitOpen,
        warn_slots: warnSlots,
      },
      200
    );
  } catch (err) {
    console.error("Critical error caught in deviceDue:", err);
    // Never crash or return 500: always return valid 200 payload
    return flatJson(
      {
        exit_open: false,
        warn_slots: [],
      },
      200
    );
  }
}

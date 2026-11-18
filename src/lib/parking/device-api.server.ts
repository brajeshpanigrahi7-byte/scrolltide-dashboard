import { sameSecret } from "./payment-security.server";
<<<<<<< HEAD
=======
import { generateCode, payUrl } from "./payments";
>>>>>>> origin/main

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
<<<<<<< HEAD
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
=======
  return sameSecret(request.headers.get("x-device-key"), process.env["DEVICE_API_KEY"])
    ? null
    : json({ error: "Unauthorized" }, 401);
}

const deviceSessionSchema = z.object({
  device: z.string().min(1).max(64),
  slot: z.number().int().min(1).max(5),
});
>>>>>>> origin/main

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
<<<<<<< HEAD

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
=======
  const parsed = deviceSessionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: "Invalid body" }, 400);
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    const { data: session, error } = await supabaseAdmin.rpc("create_device_session", {
      p_device: parsed.data.device,
      p_slot: parsed.data.slot,
      p_code: code,
    });
    if (!error && session) {
      return json(
        {
          session_id: session.id,
          code: session.code,
          pay_url: payUrl(session.code, process.env["PUBLIC_APP_URL"]),
        },
        201,
      );
    }
    if (error?.message.includes("SLOT_UNAVAILABLE")) {
      return json({ error: "Slot unavailable" }, 409);
    }
    if (error?.code !== "23505") {
      console.error("Device session creation failed", error?.message);
      return json({ error: "Could not create session" }, 500);
>>>>>>> origin/main
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
<<<<<<< HEAD
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
=======
  return json({ error: "Could not allocate a unique code" }, 500);
}

export async function devicePoll(request: Request) {
  const denied = requireDeviceKey(request);
  if (denied) return denied;
  const parsed = z.string().uuid().safeParse(new URL(request.url).searchParams.get("session"));
  if (!parsed.success) return json({ error: "Invalid session ID" }, 400);
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: session, error } = await supabaseAdmin
    .from("sessions")
    .select("id,status,duration_min,expires_at,paid_at")
    .eq("id", parsed.data)
    .maybeSingle();
  if (error || !session) return json({ error: "Unknown session" }, 404);

  if (session.status === "pending" && Date.now() >= Date.parse(session.expires_at)) {
    await supabaseAdmin.from("sessions").update({ status: "expired" }).eq("id", session.id).eq("status", "pending");
    return json({ status: "expired", duration_min: 0 });
  }

  if (session.status === "paid" && session.paid_at && Date.now() >= Date.parse(session.paid_at) + 180_000) {
    const { data: entered } = await supabaseAdmin.rpc("mark_session_entered", { p_session: session.id });
    return json({ status: "paid", duration_min: entered?.duration_min ?? session.duration_min });
  }

  const status = session.status === "active" ? "paid" : session.status;
  return json({ status, duration_min: session.status === "pending" ? 0 : session.duration_min });
}

const deviceEventSchema = z.object({
  device: z.string().min(1).max(64),
  event: z.enum(["heartbeat", "slots", "entered", "cancelled", "boot"]),
  session: z.string().uuid().optional(),
  slot: z.number().int().min(1).max(5).optional(),
  occupancy: z.string().regex(/^[01]{5}$/).optional(),
  state: z.number().int().min(0).max(4).optional(),
  dist: z.number().min(0).max(10000).optional(),
  rssi: z.number().int().min(-200).max(0).optional(),
  uptime: z.number().int().min(0).max(2_000_000_000).optional(),
  exit_open: z.boolean().optional(),
});

async function cleanupTelemetry(supabaseAdmin: any) {
  const { data: settings } = await supabaseAdmin.from("settings").select("telemetry_cleanup_at").eq("id", true).single();
  const previous = settings?.telemetry_cleanup_at as string | undefined;
  if (!previous || Date.now() - Date.parse(previous) < 60_000) return;
  const { data: claimed } = await supabaseAdmin
    .from("settings")
    .update({ telemetry_cleanup_at: new Date().toISOString() })
    .eq("id", true)
    .eq("telemetry_cleanup_at", previous)
    .select("id");
  if (claimed?.length) {
    await supabaseAdmin.from("device_telemetry").delete().lt("ts", new Date(Date.now() - 86400000).toISOString());
  }
}

export async function deviceEvent(request: Request) {
  const denied = requireDeviceKey(request);
  if (denied) return denied;
  const parsed = deviceEventSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: "Invalid event body" }, 400);
  const event = parsed.data;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const now = new Date().toISOString();

  const { data: previousDevice } = await supabaseAdmin
    .from("devices").select("entry_state,exit_open").eq("id", event.device).maybeSingle();
  const { error: deviceError } = await supabaseAdmin.from("devices").upsert({
    id: event.device,
    last_seen: now,
    ...(event.state === undefined ? {} : { entry_state: event.state }),
    ...(event.rssi === undefined ? {} : { rssi: event.rssi }),
    ...(event.uptime === undefined ? {} : { uptime_s: event.uptime }),
    ...(event.exit_open === undefined ? {} : { exit_open: event.exit_open }),
    ...(event.event === "boot" ? { boot_at: now } : {}),
  });
  if (deviceError) return json({ error: "Could not update device" }, 500);

  await supabaseAdmin.from("device_telemetry").insert({
    device_id: event.device,
    dist_cm: event.dist ?? null,
    rssi: event.rssi ?? null,
    occupancy: event.occupancy ?? null,
    entry_state: event.state ?? null,
  });

  if (event.occupancy) {
    const { data: currentSlots } = await supabaseAdmin.from("slots").select("slot,occupied").order("slot");
    for (const slot of currentSlots ?? []) {
      const occupied = event.occupancy[slot.slot - 1] === "1";
      if (occupied === slot.occupied) continue;
      await supabaseAdmin.from("slots").update({ occupied, updated_at: now }).eq("slot", slot.slot);
      await supabaseAdmin.from("activity_logs").insert({
        device: event.device, event: "slots", device_id: event.device, type: "slot_changed",
        slot: slot.slot, occupancy: event.occupancy,
        message: `Slot ${slot.slot} ${occupied ? "occupied" : "free"}`,
      });
    }
  }

  if (event.event === "boot") {
    await supabaseAdmin.from("activity_logs").insert({
      device: event.device, event: "boot", device_id: event.device, type: "boot", message: "ESP32 powered on",
    });
  }
  if (event.state === 2 && previousDevice?.entry_state !== 2) {
    await supabaseAdmin.from("activity_logs").insert({
      device: event.device, event: "entered", device_id: event.device, type: "entry_gate_opened",
      session_id: event.session ?? null, slot: event.slot ?? null, message: "Entry barrier opened",
    });
  }
  if (event.exit_open !== undefined && event.exit_open !== previousDevice?.exit_open) {
    await supabaseAdmin.from("activity_logs").insert({
      device: event.device, event: "session_expired", device_id: event.device,
      type: event.exit_open ? "exit_servo_open" : "exit_servo_closed",
      message: event.exit_open ? "Exit servo opened" : "Exit servo closed",
    });
  }

  if (event.event === "entered") {
    if (!event.session) return json({ error: "session required" }, 400);
    const { error } = await supabaseAdmin.rpc("mark_session_entered", { p_session: event.session });
    if (error) return json({ error: error.message.includes("NOT_PAID") ? "Session not paid" : "Unknown session" }, 400);
  }
  if (event.event === "cancelled") {
    if (!event.session) return json({ error: "session required" }, 400);
    const { data } = await supabaseAdmin.from("sessions").update({ status: "cancelled" })
      .eq("id", event.session).eq("status", "pending").select("id,slot,device_id");
    if (data?.length) {
      await supabaseAdmin.from("activity_logs").insert({
        device: event.device, event: "cancelled", device_id: event.device, type: "cancelled",
        session_id: event.session, slot: event.slot ?? data[0]!.slot, message: "Pending session cancelled",
      });
    }
  }

  await cleanupTelemetry(supabaseAdmin);
  return json({ ok: true });
}

export async function deviceDue(request: Request) {
  const denied = requireDeviceKey(request);
  if (denied) return denied;
  const device = z.string().min(1).max(64).safeParse(new URL(request.url).searchParams.get("device"));
  if (!device.success) return json({ error: "device parameter required" }, 400);
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: settings } = await supabaseAdmin.from("settings").select("reminder_min").eq("id", true).single();
  const { data, error } = await supabaseAdmin.rpc("device_due", {
    p_device: device.data,
    p_reminder_min: settings?.reminder_min ?? 10,
  });
  if (error) return json({ error: "Could not check due sessions" }, 500);
  return json({ exit_open: data?.[0]?.exit_open ?? false, warn_slots: data?.[0]?.warn_slots ?? [] });
>>>>>>> origin/main
}

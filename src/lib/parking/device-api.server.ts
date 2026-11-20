import { sameSecret } from "./payment-security.server";
import { generateCode } from "./payments";

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

export function requireDeviceKey(request: Request): Response | null {
  const incoming = request.headers.get("x-device-key");
  const expected = process.env.DEVICE_API_KEY;
  if (!expected || !sameSecret(incoming, expected)) {
    return flatJson({ error: "Unauthorized" }, 401);
  }
  return null;
}

let cachedDb: any = null;

export function resetDbClient(): void {
  cachedDb = null;
}

export function setTestDbClient(client: any): void {
  cachedDb = client;
}

async function getDbClient(): Promise<any> {
  if (cachedDb) return cachedDb;

  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    const missing = [
      ...(!url ? ["SUPABASE_URL"] : []),
      ...(!key ? ["SUPABASE_SERVICE_ROLE_KEY"] : []),
    ];
    console.error(`[Server DB] Missing Supabase environment variable(s): ${missing.join(", ")}`);
    throw new Error("server_not_configured");
  }

  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    if (supabaseAdmin && typeof (supabaseAdmin as any).from === "function") {
      cachedDb = supabaseAdmin;
      return cachedDb;
    }
  } catch {
    // If import threw, continue to direct createClient with validated service role key
  }

  const { createClient } = await import("@supabase/supabase-js");
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
  let slot = Number(body.slot);

  if (!device) {
    return flatJson({ error: "Need device" }, 400);
  }

  if (body.slot != null && (!Number.isInteger(slot) || slot < 1 || slot > 5)) {
    return flatJson({ error: "Need device and slot (1-5)" }, 400);
  }

  try {
    const db = await getDbClient();
    const now = new Date();
    const nowIso = now.toISOString();
    const fifteenMinAgo = new Date(now.getTime() - 15 * 60 * 1000).toISOString();

    // 0. Auto-cleanup of stale / expired sessions in database
    try {
      // Expire pending sessions whose 10-min window elapsed
      await db
        .from("sessions")
        .update({ status: "expired" })
        .in("status", ["pending", "awaiting_payment"])
        .lte("expires_at", nowIso);

      // Complete active sessions whose end_time has passed
      await db
        .from("sessions")
        .update({ status: "completed", exit_signalled_at: nowIso })
        .eq("status", "active")
        .lte("end_time", nowIso);

      // Expire abandoned paid sessions older than 15 minutes where vehicle never entered
      await db
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
      const { data: allSlots } = await db
        .from("slots")
        .select("slot, occupied")
        .order("slot", { ascending: true });

      const candidateSlots = (allSlots || [])
        .filter((s: any) => !s.occupied)
        .map((s: any) => s.slot);

      for (const cand of candidateSlots) {
        const { data: candSessions } = await db
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
        return flatJson({ error: "No available parking slots" }, 409);
      }
    }

    const publicAppUrl = (
      process.env.PUBLIC_APP_URL || "https://scrolltide-dashboard.lovable.app"
    ).replace(/\/+$/, "");

    // 1. Validate: slot is not physically occupied in slots table
    const { data: slotRow, error: slotErr } = await db
      .from("slots")
      .select("occupied")
      .eq("slot", slot)
      .maybeSingle();

    if (slotErr) {
      console.warn("Could not verify slots table, proceeding:", slotErr.message);
    } else if (slotRow?.occupied) {
      return flatJson({ error: "Slot occupied", slot }, 409);
    }

    // If slot is physically free, clean up any leftover active session whose time has ended
    if (slotRow && !slotRow.occupied) {
      try {
        await db
          .from("sessions")
          .update({ status: "completed", exit_signalled_at: nowIso })
          .eq("slot", slot)
          .eq("status", "active")
          .lte("end_time", nowIso);
      } catch {}
    }

    // 2. Safe Idempotency: Check if an unexpired session already exists for this device & slot
    // a) Existing unexpired pending session: return existing session without breaking QR code
    const { data: existingPending } = await db
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
      return flatJson(
        {
          session_id: existingPending.id,
          code: existingPending.code,
          pay_url: `${publicAppUrl}/p/${existingPending.code}`,
        },
        200,
      );
    }

    // b) Existing paid session awaiting entry for this device & slot
    const { data: existingPaid } = await db
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
      return flatJson(
        {
          session_id: existingPaid.id,
          code: existingPaid.code,
          status: "paid",
          pay_url: `${publicAppUrl}/p/${existingPaid.code}`,
        },
        200,
      );
    }

    // 3. Validate: slot has no currently active or paid session from another car
    const { data: activeSessions, error: confErr } = await db
      .from("sessions")
      .select("id, status, end_time, created_at, entered_at, device_id")
      .eq("slot", slot)
      .in("status", ["paid", "active"]);

    if (confErr) {
      console.warn("Error querying active sessions:", confErr.message);
    } else if (activeSessions && activeSessions.length > 0) {
      const activeBlocker = activeSessions.find((s: any) => {
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
        return flatJson({ error: "Slot reserved", slot }, 409);
      }
    }

    // 4. Expire any older pending/awaiting_payment sessions for this slot
    //    and device BEFORE checking for active sessions to avoid false reservation errors
    await db
      .from("sessions")
      .update({ status: "expired" })
      .eq("slot", slot)
      .in("status", ["pending", "awaiting_payment"]);

    await db
      .from("sessions")
      .update({ status: "expired" })
      .eq("device_id", device)
      .in("status", ["pending", "awaiting_payment"]);

    // 5. Validate: slot has no currently active or paid session from another car

    await db
      .from("sessions")
      .update({ status: "expired" })
      .eq("slot", slot)
      .in("status", ["pending", "awaiting_payment"]);

    await db
      .from("sessions")
      .update({ status: "expired" })
      .eq("device_id", device)
      .in("status", ["pending", "awaiting_payment"]);

    // 5. Generate unique 8-character cryptographically secure token
    let code = "";
    for (let i = 0; i < 5; i++) {
      const candidate = generateCode(8);
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

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    // 6. Create new session with pending status
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

    // 7. Log session created
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

    const payUrl = `${publicAppUrl}/p/${code}`;

    return flatJson(
      {
        session_id: newSession.id,
        code: newSession.code,
        pay_url: payUrl,
      },
      201,
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
      200,
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
    const occupancy =
      typeof body.occupancy === "string" && /^[01]{5}$/.test(body.occupancy)
        ? body.occupancy
        : null;

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

    const { error: devErr } = await db.from("devices").upsert(deviceUpdate, { onConflict: "id" });
    if (devErr) {
      console.error("Failed to upsert devices row:", devErr.message);
      return flatJson({ error: devErr.message }, 500);
    }

    // Update slots from occupancy
    if (occupancy) {
      try {
        const { data: currentSlots, error: slotsFetchErr } = await db
          .from("slots")
          .select("slot, occupied")
          .order("slot", { ascending: true });

        if (slotsFetchErr) {
          console.error("Failed to read slots for occupancy check:", slotsFetchErr.message);
          return flatJson({ error: slotsFetchErr.message }, 500);
        }

        const currentMap = new Map((currentSlots || []).map((s: any) => [s.slot, s.occupied]));

        for (let i = 0; i < 5; i++) {
          const slotNum = i + 1;
          const isOccupied = occupancy[i] === "1";
          const wasOccupied = currentMap.get(slotNum);

          if (wasOccupied !== isOccupied) {
            const { error: slotErr } = await db.from("slots").upsert(
              {
                slot: slotNum,
                occupied: isOccupied,
                updated_at: nowIso,
              },
              { onConflict: "slot" },
            );

            if (slotErr) {
              console.error(`Failed to upsert slot ${slotNum}:`, slotErr.message);
              return flatJson({ error: slotErr.message }, 500);
            }

            // When a slot changes from occupied (1) to free (0), release any active session!
            if (wasOccupied && !isOccupied) {
              try {
                await db
                  .from("sessions")
                  .update({
                    status: "completed",
                    exit_signalled_at: nowIso,
                  })
                  .eq("slot", slotNum)
                  .eq("status", "active");

                await db.from("activity_logs").insert({
                  device_id: device,
                  type: "slot_freed",
                  slot: slotNum,
                  message: `Vehicle exited slot ${slotNum}. Slot is now free.`,
                });
              } catch (sessErr) {
                console.warn(`Could not mark slot ${slotNum} session completed:`, sessErr);
              }
            } else {
              await db.from("activity_logs").insert({
                device_id: device,
                type: "slot_change",
                slot: slotNum,
                message: `Slot ${slotNum} is now ${isOccupied ? "occupied" : "free"}`,
              });
            }
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
    } else if (event === "exited" || event === "leave_now" || event === "exit") {
      try {
        if (session) {
          await db
            .from("sessions")
            .update({ status: "completed", exit_signalled_at: nowIso })
            .eq("id", session);
        } else if (slot) {
          await db
            .from("sessions")
            .update({ status: "completed", exit_signalled_at: nowIso })
            .eq("slot", slot)
            .eq("status", "active");
        }
      } catch (e) {
        console.warn("Could not handle exit event:", e);
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

    // Check ended active sessions (end_time <= now)
    try {
      const { data: expiredSessions, error: expErr } = await db
        .from("sessions")
        .select("id, slot, exit_signalled_at")
        .eq("status", "active")
        .lte("end_time", nowIso);

      if (
        !expErr &&
        expiredSessions &&
        Array.isArray(expiredSessions) &&
        expiredSessions.length > 0
      ) {
        for (const exp of expiredSessions) {
          const shouldSignalExit = !exp.exit_signalled_at;
          await db
            .from("sessions")
            .update({
              status: "completed",
              ...(shouldSignalExit ? { exit_signalled_at: nowIso } : {}),
            })
            .eq("id", exp.id);

          if (shouldSignalExit) {
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
      200,
    );
  } catch (err) {
    console.error("Critical error caught in deviceDue:", err);
    // Never crash or return 500: always return valid 200 payload
    return flatJson(
      {
        exit_open: false,
        warn_slots: [],
      },
      200,
    );
  }
}

// ─── 5. Admin Stale Session Cleanup & Database Repair ───
export async function cleanStaleSessions(): Promise<{
  ok: boolean;
  cleaned: number;
  message: string;
}> {
  const db = await getDbClient();
  const now = new Date();
  const nowIso = now.toISOString();
  const fifteenMinAgo = new Date(now.getTime() - 15 * 60 * 1000).toISOString();

  let count = 0;

  try {
    // 1. Expire pending sessions whose 10-minute window elapsed
    const { data: expPending } = await db
      .from("sessions")
      .update({ status: "expired" })
      .in("status", ["pending", "awaiting_payment"])
      .lte("expires_at", nowIso)
      .select("id");
    count += expPending?.length || 0;

    // 2. Complete active sessions whose end_time has passed
    const { data: compActive } = await db
      .from("sessions")
      .update({ status: "completed", exit_signalled_at: nowIso })
      .eq("status", "active")
      .lte("end_time", nowIso)
      .select("id");
    count += compActive?.length || 0;

    // 3. Expire abandoned paid sessions older than 15 minutes where vehicle never entered
    const { data: expPaid } = await db
      .from("sessions")
      .update({ status: "expired" })
      .eq("status", "paid")
      .is("entered_at", null)
      .lte("created_at", fifteenMinAgo)
      .select("id");
    count += expPaid?.length || 0;

    // 4. For any slot marked physically free in slots table, complete any active session
    const { data: freeSlots } = await db.from("slots").select("slot").eq("occupied", false);
    if (freeSlots && freeSlots.length > 0) {
      for (const fs of freeSlots) {
        const { data: vacated } = await db
          .from("sessions")
          .update({ status: "completed", exit_signalled_at: nowIso })
          .eq("slot", fs.slot)
          .eq("status", "active")
          .select("id");
        count += vacated?.length || 0;
      }
    }
  } catch (err) {
    console.warn("Error during cleanStaleSessions:", err);
  }

  return {
    ok: true,
    cleaned: count,
    message: `Cleaned ${count} stale or expired session(s). All slots are synchronized.`,
  };
}

// ─── 6. Safe Health Endpoint GET /api/public/device-health ───
export async function deviceHealth(request: Request): Promise<Response> {
  const denied = requireDeviceKey(request);
  if (denied) return denied;

  const dbAdminConfigured = Boolean(
    (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL) &&
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  );
  const deviceKeyConfigured = Boolean(process.env.DEVICE_API_KEY);

  let deviceRow: { id: string; last_seen: string | null; age_s: number | null } | null = null;

  if (dbAdminConfigured) {
    try {
      const db = await getDbClient();
      const url = new URL(request.url);
      const deviceId = url.searchParams.get("device")?.trim() || "esp32-entry-1";
      const { data, error } = await db
        .from("devices")
        .select("id, last_seen")
        .eq("id", deviceId)
        .maybeSingle();

      if (!error && data) {
        const ageS = data.last_seen
          ? Math.max(0, Math.floor((Date.now() - new Date(data.last_seen).getTime()) / 1000))
          : null;
        deviceRow = {
          id: data.id,
          last_seen: data.last_seen,
          age_s: ageS,
        };
      }
    } catch (err) {
      console.error("deviceHealth db query error:", err);
    }
  }

  return flatJson(
    {
      db_admin_configured: dbAdminConfigured,
      device_key_configured: deviceKeyConfigured,
      device_row: deviceRow,
    },
    200,
  );
}

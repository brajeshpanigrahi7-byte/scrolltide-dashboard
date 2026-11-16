import { z } from "zod";
import { sameSecret } from "./payment-security.server";
import { generateCode, payUrl } from "./payments";

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

function requireDeviceKey(request: Request): Response | null {
  return sameSecret(request.headers.get("x-device-key"), process.env["DEVICE_API_KEY"])
    ? null
    : json({ error: "Unauthorized" }, 401);
}

const deviceSessionSchema = z.object({
  device: z.string().min(1).max(64),
  slot: z.number().int().min(1).max(5),
});

export async function deviceSession(request: Request) {
  const denied = requireDeviceKey(request);
  if (denied) return denied;
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
    }
  }
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
      session: undefined, session_id: event.session ?? null, slot: event.slot ?? null, message: "Entry barrier opened",
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
}

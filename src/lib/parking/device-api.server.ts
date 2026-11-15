import { z } from "zod";
import { sameSecret } from "./payment-security.server";
import { generateCode, payUrl, sessionIdSchema, RATE_PER_30MIN, MAX_DURATION_MIN } from "./payments";

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

function requireDeviceKey(request: Request): Response | null {
  if (!sameSecret(request.headers.get("x-device-key"), process.env["DEVICE_API_KEY"])) {
    return json({ error: "Unauthorized" }, 401);
  }
  return null;
}

// ─── 1. POST /api/public/device-session ───
const deviceSessionSchema = z.object({
  device: z.string().min(1).max(64),
  slot: z.number().int().min(1).max(5),
});

export async function deviceSession(request: Request) {
  const denied = requireDeviceKey(request);
  if (denied) return denied;

  const parsed = deviceSessionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: "Invalid body: need device and slot (1-5)" }, 400);

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  // Generate a unique 6-char code with retry
  let code: string | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateCode();
    const { data } = await supabaseAdmin
      .from("parking_sessions")
      .select("id")
      .eq("code", candidate)
      .maybeSingle();
    if (!data) {
      code = candidate;
      break;
    }
  }
  if (!code) return json({ error: "Could not generate unique code" }, 500);

  const { data: session, error } = await supabaseAdmin
    .from("parking_sessions")
    .insert({
      slot: parsed.data.slot,
      amount_inr: RATE_PER_30MIN, // minimum; driver picks duration on the page
      status: "awaiting_payment",
      code,
    })
    .select()
    .single();

  if (error || !session) return json({ error: "Could not create session" }, 500);

  // Log activity
  await supabaseAdmin.from("activity_logs").insert({
    device: parsed.data.device,
    event: "session_created",
    session_id: session.id,
    slot: parsed.data.slot,
  });

  return json({
    session_id: session.id,
    code,
    pay_url: payUrl(code),
  });
}

// ─── 2. GET /api/public/device-poll?session=<id> ───
export async function devicePoll(request: Request) {
  const denied = requireDeviceKey(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const parsed = sessionIdSchema.safeParse(url.searchParams.get("session"));
  if (!parsed.success) return json({ error: "Invalid session ID" }, 400);

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data: session, error } = await supabaseAdmin
    .from("parking_sessions")
    .select("status, created_at, duration_min")
    .eq("id", parsed.data)
    .single();

  if (error || !session) return json({ error: "Unknown session" }, 404);

  // Auto-expire stale awaiting_payment sessions (>10 min)
  if (
    session.status === "awaiting_payment" &&
    Date.now() >= Date.parse(session.created_at) + 10 * 60 * 1000
  ) {
    await supabaseAdmin
      .from("parking_sessions")
      .update({ status: "expired" })
      .eq("id", parsed.data)
      .eq("status", "awaiting_payment");
    return json({ status: "expired", duration_min: session.duration_min ?? 30 });
  }

  // Map internal status to device-facing status
  let deviceStatus: string;
  switch (session.status) {
    case "awaiting_payment":
      deviceStatus = "pending";
      break;
    case "paid":
    case "active":
      deviceStatus = "paid";
      break;
    case "expired":
      deviceStatus = "expired";
      break;
    case "cancelled":
      deviceStatus = "cancelled";
      break;
    default:
      deviceStatus = session.status;
  }

  return json({ status: deviceStatus, duration_min: session.duration_min ?? 30 });
}

// ─── 3. POST /api/public/device-event ───
const deviceEventSchema = z.object({
  device: z.string().min(1).max(64),
  event: z.enum(["heartbeat", "slots", "entered", "cancelled"]),
  session: z.string().uuid().optional(),
  slot: z.number().int().min(1).max(5).optional(),
  occupancy: z.string().regex(/^[01]{5}$/).optional(),
});

export async function deviceEvent(request: Request) {
  const denied = requireDeviceKey(request);
  if (denied) return denied;

  const parsed = deviceEventSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: "Invalid event body" }, 400);

  const { device, event, session, slot, occupancy } = parsed.data;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  switch (event) {
    case "heartbeat": {
      await supabaseAdmin
        .from("esp32_devices")
        .upsert({ device, last_seen_at: new Date().toISOString() }, { onConflict: "device" });
      break;
    }
    case "slots": {
      if (!occupancy) return json({ error: "occupancy required for slots event" }, 400);
      await supabaseAdmin
        .from("esp32_devices")
        .upsert(
          { device, slot_occupancy: occupancy, last_seen_at: new Date().toISOString() },
          { onConflict: "device" },
        );
      break;
    }
    case "entered": {
      if (!session) return json({ error: "session required for entered event" }, 400);
      const now = new Date();
      const { data: sess } = await supabaseAdmin
        .from("parking_sessions")
        .select("duration_min, status")
        .eq("id", session)
        .single();
      if (!sess) return json({ error: "Unknown session" }, 404);
      if (sess.status !== "paid") return json({ error: "Session not in paid status" }, 400);
      const durationMin = sess.duration_min ?? 30;
      const endsAt = new Date(now.getTime() + durationMin * 60 * 1000);
      await supabaseAdmin
        .from("parking_sessions")
        .update({
          status: "active",
          entered_at: now.toISOString(),
          ends_at: endsAt.toISOString(),
        })
        .eq("id", session)
        .eq("status", "paid");
      break;
    }
    case "cancelled": {
      if (!session) return json({ error: "session required for cancelled event" }, 400);
      await supabaseAdmin
        .from("parking_sessions")
        .update({ status: "cancelled" })
        .eq("id", session)
        .in("status", ["awaiting_payment", "paid"]);
      break;
    }
  }

  // Write to activity logs
  await supabaseAdmin.from("activity_logs").insert({
    device,
    event,
    session_id: session ?? null,
    slot: slot ?? null,
    occupancy: occupancy ?? null,
  });

  return json({ ok: true });
}

// ─── 4. GET /api/public/device-due?device=<id> ───
export async function deviceDue(request: Request) {
  const denied = requireDeviceKey(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const device = url.searchParams.get("device");
  if (!device) return json({ error: "device parameter required" }, 400);

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  // Signal exit: find one active session past its ends_at with exit_signalled=false
  // Use the database function for atomicity
  const { data: exitRows } = await supabaseAdmin.rpc("signal_exit_and_complete");
  const exitOpen = Array.isArray(exitRows) && exitRows.length > 0;

  if (exitOpen) {
    // Log the exit signal
    const row = exitRows![0]!;
    await supabaseAdmin.from("activity_logs").insert({
      device,
      event: "session_expired",
      session_id: row.session_id,
      slot: row.slot,
    });
  }

  // Warn slots: active sessions ending within 10 minutes
  const warnThreshold = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const { data: warnRows } = await supabaseAdmin
    .from("parking_sessions")
    .select("slot")
    .eq("status", "active")
    .lte("ends_at", warnThreshold)
    .eq("exit_signalled", false);

  const warnSlots = (warnRows ?? []).map((r) => r.slot);

  return json({ exit_open: exitOpen, warn_slots: warnSlots });
}

import { z } from "zod";
import { sameSecret } from "./payment-security.server";
import { generateCode, payUrl, sessionIdSchema, RATE_PER_30MIN } from "./payments";

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

  // Generate a unique 6-char code using A-Z and 2-9
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

  const amount_inr = RATE_PER_30MIN; // ₹20 base rate for initial 30 min

  const { data: session, error } = await supabaseAdmin
    .from("parking_sessions")
    .insert({
      slot: parsed.data.slot,
      amount_inr,
      duration_min: 30,
      status: "awaiting_payment",
      code,
    })
    .select()
    .single();

  if (error || !session) return json({ error: "Could not create session" }, 500);

  // Log session created to Activity Logs
  try {
    await supabaseAdmin.from("activity_logs").insert({
      device: parsed.data.device,
      event: "session_created",
      session_id: session.id,
      slot: parsed.data.slot,
    });
  } catch (e) {
    console.error("Failed to write session_created log", e);
  }

  const keyId = process.env["RAZORPAY_KEY_ID"];
  const keySecret = process.env["RAZORPAY_KEY_SECRET"];
  let shortUrl: string | null = null;

  if (keyId && keySecret) {
    // Attempt 1: Razorpay Payment Link
    // Payment Links need expire_by at least 15 minutes in the future: use now + 30 minutes (integer Unix seconds)
    // reference_id must be unique, up to 40 chars. amount is an integer in paise.
    const expire_by = Math.floor(Date.now() / 1000) + 30 * 60; // 30 mins in future
    const amountPaise = Math.round(amount_inr * 100);

    try {
      const response = await fetch("https://api.razorpay.com/v1/payment_links", {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${keyId}:${keySecret}`)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          amount: amountPaise,
          currency: "INR",
          accept_partial: false,
          reference_id: session.id.slice(0, 40),
          description: `Parking slot ${session.slot}`,
          expire_by,
          notes: {
            session_id: session.id,
            slot: session.slot,
            code,
            device: parsed.data.device,
          },
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (response.ok) {
        const link = (await response.json()) as { id: string; short_url: string };
        shortUrl = link.short_url;
        await supabaseAdmin
          .from("parking_sessions")
          .update({ payment_link_id: link.id, short_url: link.short_url })
          .eq("id", session.id);
      } else {
        // Log Razorpay's full error body in function logs and in Activity Logs
        const errorBody = await response.text();
        console.error("Razorpay create-link rejected:", response.status, errorBody);

        try {
          await supabaseAdmin.from("activity_logs").insert({
            device: parsed.data.device,
            event: "link_creation_failed",
            session_id: session.id,
            slot: session.slot,
            meta: { status: response.status, error: errorBody },
          });
        } catch (logErr) {
          console.error("Failed to write link_creation_failed to activity_logs", logErr);
        }

        // Fallback: Orders API (POST /v1/orders)
        try {
          const orderRes = await fetch("https://api.razorpay.com/v1/orders", {
            method: "POST",
            headers: {
              Authorization: `Basic ${btoa(`${keyId}:${keySecret}`)}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              amount: amountPaise,
              currency: "INR",
              receipt: session.id.slice(0, 40),
              notes: {
                session_id: session.id,
                slot: session.slot,
                code,
                device: parsed.data.device,
              },
            }),
            signal: AbortSignal.timeout(15000),
          });

          if (orderRes.ok) {
            const orderData = (await orderRes.json()) as { id: string };
            await supabaseAdmin
              .from("parking_sessions")
              .update({ razorpay_order_id: orderData.id })
              .eq("id", session.id);
          } else {
            const orderError = await orderRes.text();
            console.error("Razorpay create-order rejected:", orderRes.status, orderError);
          }
        } catch (orderErr) {
          console.error("Razorpay order creation fallback failed", orderErr);
        }
      }
    } catch (linkErr) {
      console.error("Payment Link creation request threw:", linkErr);
    }
  }

  // pay_url = https://scrolltide-dashboard.lovable.app/p/<code> and must stay under 53 characters
  const pay_url = payUrl(code);

  return json({
    session_id: session.id,
    code,
    pay_url,
    ...(shortUrl ? { short_url: shortUrl } : {}),
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

  // Awaiting_payment older than 10 minutes becomes expired
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

  // status is "pending" while awaiting_payment, "paid" once paid or active, otherwise "expired" or "cancelled"
  let status: string;
  if (session.status === "awaiting_payment") {
    status = "pending";
  } else if (session.status === "paid" || session.status === "active") {
    status = "paid";
  } else if (session.status === "expired") {
    status = "expired";
  } else if (session.status === "cancelled") {
    status = "cancelled";
  } else {
    status = session.status;
  }

  return json({ status, duration_min: session.duration_min ?? 30 });
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
      // heartbeat (update ESP32 last-seen)
      await supabaseAdmin
        .from("esp32_devices")
        .upsert({ device, last_seen_at: new Date().toISOString() }, { onConflict: "device" });
      break;
    }
    case "slots": {
      // slots (occupancy string like "10110" updates the 5 slots live)
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
      // entered (status active, entered_at = now, ends_at = now + duration_min)
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

  // Write each to Activity Logs
  try {
    await supabaseAdmin.from("activity_logs").insert({
      device,
      event,
      session_id: session ?? null,
      slot: slot ?? null,
      occupancy: occupancy ?? null,
    });
  } catch (e) {
    console.error("Failed to write to activity_logs", e);
  }

  return json({ ok: true });
}

// ─── 4. GET /api/public/device-due?device=:device ───
export async function deviceDue(request: Request) {
  const denied = requireDeviceKey(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const device = url.searchParams.get("device");
  if (!device) return json({ error: "device parameter required" }, 400);

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  // exit_open is true when an active session has ends_at <= now and exit_signalled = false;
  // in the same call set exit_signalled = true and status completed so it is true only once.
  const { data: exitRows } = await supabaseAdmin.rpc("signal_exit_and_complete");
  const exitOpen = Array.isArray(exitRows) && exitRows.length > 0;

  if (exitOpen) {
    const row = exitRows![0]!;
    try {
      await supabaseAdmin.from("activity_logs").insert({
        device,
        event: "session_expired",
        session_id: row.session_id,
        slot: row.slot,
      });
    } catch (e) {
      console.error("Failed to write exit activity_log", e);
    }
  }

  // warn_slots = slots of active sessions ending within 10 minutes
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

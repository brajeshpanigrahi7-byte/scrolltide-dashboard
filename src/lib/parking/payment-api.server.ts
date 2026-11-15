import { z } from "zod";
import { sameSecret, validWebhook } from "./payment-security.server";

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

// ─── POST /api/public/razorpay-webhook ───
// Handles payment.captured and order.paid events from Razorpay
export async function razorpayWebhook(request: Request) {
  const raw = await request.text();
  if (!process.env["RAZORPAY_WEBHOOK_SECRET"])
    return json({ error: "Webhook is not configured" }, 503);
  if (
    !validWebhook(
      raw,
      request.headers.get("x-razorpay-signature"),
      process.env["RAZORPAY_WEBHOOK_SECRET"],
    )
  )
    return json({ error: "Invalid signature" }, 401);

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "Invalid payment event" }, 400);
  }

  const event = z.object({ event: z.string().min(1).max(100) }).safeParse(body);
  if (!event.success) return json({ error: "Invalid payment event" }, 400);

  // Accept both payment.captured and order.paid
  if (event.data.event !== "payment.captured" && event.data.event !== "order.paid")
    return json({ received: true });

  // Extract order_id and payment_id from the payload
  const payloadSchema = z.object({
    payload: z.object({
      payment: z
        .object({
          entity: z.object({
            id: z.string(), // pay_xxx
            order_id: z.string(), // order_xxx
            amount: z.number().int(),
            currency: z.string(),
            status: z.string(),
            notes: z
              .object({
                session_id: z.string().uuid().optional(),
                extend: z.boolean().optional(),
                extra_minutes: z.number().optional(),
              })
              .passthrough()
              .optional(),
          }),
        })
        .optional(),
      order: z
        .object({
          entity: z.object({
            id: z.string(),
            receipt: z.string().optional(),
            amount: z.number().int(),
            amount_paid: z.number().int(),
            currency: z.string(),
            status: z.string(),
            notes: z
              .object({
                session_id: z.string().uuid().optional(),
                extend: z.boolean().optional(),
                extra_minutes: z.number().optional(),
              })
              .passthrough()
              .optional(),
          }),
        })
        .optional(),
    }),
  });

  const parsed = payloadSchema.safeParse(body);
  if (!parsed.success) return json({ error: "Invalid payment payload" }, 400);

  const payment = parsed.data.payload.payment?.entity;
  const order = parsed.data.payload.order?.entity;
  if (!payment && !order) return json({ error: "No payment or order in payload" }, 400);

  // Resolve session_id from payment notes, order notes, or order receipt
  const sessionId =
    payment?.notes?.session_id ??
    order?.notes?.session_id ??
    (order?.receipt && !order.receipt.includes("_ext_") ? order.receipt : undefined);

  if (!sessionId) return json({ error: "No session_id in payment notes" }, 400);

  const isExtend =
    payment?.notes?.extend === true ||
    order?.notes?.extend === true ||
    (order?.receipt?.includes("_ext_") ?? false);

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  if (isExtend) {
    // Extension payment
    const extraMinutes =
      payment?.notes?.extra_minutes ??
      order?.notes?.extra_minutes ??
      (order?.receipt ? parseInt(order.receipt.split("_ext_")[1] ?? "30", 10) : 30);

    // Get the current session to find base session_id (extensions use receipt = session_id_ext_N)
    const baseSessionId = order?.receipt?.includes("_ext_")
      ? order.receipt.split("_ext_")[0]!
      : sessionId;

    const { data: session } = await supabaseAdmin
      .from("parking_sessions")
      .select("*")
      .eq("id", baseSessionId)
      .single();

    if (!session) return json({ error: "Unknown session" }, 404);
    if (session.status !== "active") return json({ error: "Session not active for extension" }, 400);

    // Add minutes to duration_min and ends_at, reset reminder_sent
    const newDuration = (session.duration_min ?? 30) + extraMinutes;
    const currentEndsAt = session.ends_at ? new Date(session.ends_at) : new Date();
    const newEndsAt = new Date(currentEndsAt.getTime() + extraMinutes * 60 * 1000);

    await supabaseAdmin
      .from("parking_sessions")
      .update({
        duration_min: newDuration,
        amount_inr: session.amount_inr + (extraMinutes / 30) * 20,
        ends_at: newEndsAt.toISOString(),
        reminder_sent: false,
        razorpay_payment_id: payment?.id ?? session.razorpay_payment_id,
      })
      .eq("id", baseSessionId);

    await supabaseAdmin.from("activity_logs").insert({
      device: "webhook",
      event: "payment_received",
      session_id: baseSessionId,
      slot: session.slot,
      meta: { type: "extend", extra_minutes: extraMinutes, order_id: order?.id ?? payment?.order_id },
    });

    return json({ received: true, extended: true });
  }

  // Normal payment — mark session as paid
  const { data: session } = await supabaseAdmin
    .from("parking_sessions")
    .select("*")
    .eq("id", sessionId)
    .single();

  if (!session) return json({ error: "Unknown session" }, 404);

  // Idempotent: if already paid/active/completed, skip
  if (session.status === "paid" || session.status === "active" || session.status === "completed")
    return json({ received: true, already: true });

  // Only mark paid from awaiting_payment or expired (webhook might arrive after auto-expire)
  const result = await supabaseAdmin
    .from("parking_sessions")
    .update({
      status: "paid",
      paid_at: new Date().toISOString(),
      razorpay_order_id: payment?.order_id ?? order?.id ?? session.razorpay_order_id,
      razorpay_payment_id: payment?.id ?? session.razorpay_payment_id,
    })
    .eq("id", session.id)
    .in("status", ["awaiting_payment", "expired"]);

  if (result.error) return json({ error: "Payment confirmation could not be saved" }, 500);

  await supabaseAdmin.from("activity_logs").insert({
    device: "webhook",
    event: "payment_received",
    session_id: session.id,
    slot: session.slot,
    meta: { order_id: payment?.order_id ?? order?.id },
  });

  return json({ received: true });
}

// ─── GET /api/public/session-status?id=<uuid> ───
// Used by the driver page to poll session status after payment
export async function sessionStatus(request: Request) {
  const url = new URL(request.url);
  const idParam = url.searchParams.get("id");
  const codeParam = url.searchParams.get("code");

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  let session: {
    id: string;
    status: string;
    slot: number;
    duration_min: number | null;
    amount_inr: number;
    created_at: string;
    entered_at: string | null;
    ends_at: string | null;
    code: string | null;
  } | null = null;

  if (idParam) {
    const parsed = z.string().uuid().safeParse(idParam);
    if (!parsed.success) return json({ error: "Invalid session ID" }, 400);
    const { data } = await supabaseAdmin
      .from("parking_sessions")
      .select("id, status, slot, duration_min, amount_inr, created_at, entered_at, ends_at, code")
      .eq("id", parsed.data)
      .single();
    session = data;
  } else if (codeParam) {
    const parsed = z.string().length(6).safeParse(codeParam);
    if (!parsed.success) return json({ error: "Invalid code" }, 400);
    const { data } = await supabaseAdmin
      .from("parking_sessions")
      .select("id, status, slot, duration_min, amount_inr, created_at, entered_at, ends_at, code")
      .eq("code", parsed.data)
      .single();
    session = data;
  } else {
    return json({ error: "Provide id or code parameter" }, 400);
  }

  if (!session) return json({ error: "Unknown session" }, 404);

  // Auto-expire if needed
  if (
    session.status === "awaiting_payment" &&
    Date.now() >= Date.parse(session.created_at) + 10 * 60 * 1000
  ) {
    await supabaseAdmin
      .from("parking_sessions")
      .update({ status: "expired" })
      .eq("id", session.id)
      .eq("status", "awaiting_payment");
    session.status = "expired";
  }

  return json({
    id: session.id,
    status: session.status,
    slot: session.slot,
    duration_min: session.duration_min ?? 30,
    amount_inr: session.amount_inr,
    entered_at: session.entered_at,
    ends_at: session.ends_at,
    code: session.code,
  });
}

// Keep backward compat: createSession still used from old route
export { deviceSession as createSession } from "./device-api.server";

import { z } from "zod";
import { sameSecret, validWebhook } from "./payment-security.server";
import { generateCode, payUrl, sessionIdSchema, RATE_PER_30MIN } from "./payments";

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

// ─── POST /api/public/razorpay-webhook ───
// Only the Razorpay webhook (payment.captured, order.paid, payment_link.paid) may set a session to paid,
// after verifying X-Razorpay-Signature.
export async function razorpayWebhook(request: Request) {
  const raw = await request.text();
  const webhookSecret = process.env["RAZORPAY_WEBHOOK_SECRET"];
  if (!webhookSecret) return json({ error: "Webhook is not configured" }, 503);

  const signature = request.headers.get("x-razorpay-signature");
  if (!validWebhook(raw, signature, webhookSecret)) {
    console.error("Razorpay webhook signature verification failed");
    return json({ error: "Invalid signature" }, 401);
  }

  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "Invalid payment event" }, 400);
  }

  const eventName = body?.event;
  if (
    eventName !== "payment.captured" &&
    eventName !== "order.paid" &&
    eventName !== "payment_link.paid"
  ) {
    return json({ received: true });
  }

  const paymentLink = body?.payload?.payment_link?.entity;
  const order = body?.payload?.order?.entity;
  const payment = body?.payload?.payment?.entity;

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  // Determine session ID
  let sessionId: string | undefined =
    paymentLink?.reference_id ||
    order?.receipt ||
    order?.notes?.session_id ||
    payment?.notes?.session_id;

  // If receipt has _ext_, extract base session ID
  const isExtend =
    order?.notes?.extend === true ||
    payment?.notes?.extend === true ||
    (typeof order?.receipt === "string" && order.receipt.includes("_ext_"));

  if (isExtend && typeof order?.receipt === "string" && order.receipt.includes("_ext_")) {
    sessionId = order.receipt.split("_ext_")[0];
  }

  // Fallback: look up by payment_link_id or razorpay_order_id
  let session: any = null;
  if (sessionId) {
    const { data } = await supabaseAdmin
      .from("parking_sessions")
      .select("*")
      .eq("id", sessionId)
      .maybeSingle();
    session = data;
  }

  if (!session && paymentLink?.id) {
    const { data } = await supabaseAdmin
      .from("parking_sessions")
      .select("*")
      .eq("payment_link_id", paymentLink.id)
      .maybeSingle();
    session = data;
  }

  if (!session && (order?.id || payment?.order_id)) {
    const orderIdToMatch = order?.id || payment?.order_id;
    const { data } = await supabaseAdmin
      .from("parking_sessions")
      .select("*")
      .eq("razorpay_order_id", orderIdToMatch)
      .maybeSingle();
    session = data;
  }

  if (!session) {
    console.error("Razorpay webhook: Unknown session", {
      sessionId,
      paymentLinkId: paymentLink?.id,
      orderId: order?.id,
    });
    return json({ error: "Unknown session" }, 404);
  }

  // Handle extension
  if (isExtend) {
    const extraMinutes = Number(
      order?.notes?.extra_minutes ??
        payment?.notes?.extra_minutes ??
        (order?.receipt ? order.receipt.split("_ext_")[1] : 30) ||
        30,
    );

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
        razorpay_payment_id: payment?.id || session.razorpay_payment_id,
      })
      .eq("id", session.id);

    try {
      await supabaseAdmin.from("activity_logs").insert({
        device: "webhook",
        event: "payment_received",
        session_id: session.id,
        slot: session.slot,
        meta: {
          type: "extend",
          extra_minutes: extraMinutes,
          event: eventName,
          payment_id: payment?.id,
        },
      });
    } catch (e) {
      console.error("Failed to write to activity_logs", e);
    }

    return json({ received: true, extended: true });
  }

  // Idempotent check: if already paid, active, or completed, don't overwrite
  if (session.status === "paid" || session.status === "active" || session.status === "completed") {
    return json({ received: true, already_processed: true });
  }

  // Set session to paid (only allowable from webhook after signature check)
  const result = await supabaseAdmin
    .from("parking_sessions")
    .update({
      status: "paid",
      paid_at: new Date().toISOString(),
      razorpay_order_id: order?.id || payment?.order_id || session.razorpay_order_id,
      razorpay_payment_id: payment?.id || session.razorpay_payment_id,
    })
    .eq("id", session.id)
    .in("status", ["awaiting_payment", "pending", "expired"]);

  if (result.error) {
    console.error("Failed to update parking session status to paid", result.error);
    return json({ error: "Payment confirmation could not be saved" }, 500);
  }

  try {
    await supabaseAdmin.from("activity_logs").insert({
      device: "webhook",
      event: "payment_received",
      session_id: session.id,
      slot: session.slot,
      meta: {
        event: eventName,
        payment_id: payment?.id,
        order_id: order?.id || payment?.order_id,
        payment_link_id: paymentLink?.id,
      },
    });
  } catch (e) {
    console.error("Failed to write to activity_logs", e);
  }

  return json({ received: true });
}

// ─── GET /api/public/session-status ───
export async function sessionStatus(request: Request) {
  const url = new URL(request.url);
  const idParam = url.searchParams.get("id");
  const codeParam = url.searchParams.get("code");

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  let session: any = null;

  if (idParam) {
    const parsed = sessionIdSchema.safeParse(idParam);
    if (!parsed.success) return json({ error: "Invalid session ID" }, 400);
    const { data } = await supabaseAdmin
      .from("parking_sessions")
      .select("id, status, slot, duration_min, amount_inr, created_at, entered_at, ends_at, code, short_url")
      .eq("id", parsed.data)
      .maybeSingle();
    session = data;
  } else if (codeParam) {
    const parsed = z.string().length(6).safeParse(codeParam);
    if (!parsed.success) return json({ error: "Invalid code" }, 400);
    const { data } = await supabaseAdmin
      .from("parking_sessions")
      .select("id, status, slot, duration_min, amount_inr, created_at, entered_at, ends_at, code, short_url")
      .eq("code", parsed.data)
      .maybeSingle();
    session = data;
  } else {
    return json({ error: "Provide id or code parameter" }, 400);
  }

  if (!session) return json({ error: "Unknown session" }, 404);

  // Awaiting_payment older than 10 minutes becomes expired
  if (
    (session.status === "awaiting_payment" || session.status === "pending") &&
    Date.now() >= Date.parse(session.created_at) + 10 * 60 * 1000
  ) {
    await supabaseAdmin
      .from("parking_sessions")
      .update({ status: "expired" })
      .eq("id", session.id)
      .in("status", ["awaiting_payment", "pending"]);
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
    short_url: session.short_url,
  });
}

// ─── POST /api/public/create-session ───
// Also accessible for testing or device creation
export { deviceSession as createSession } from "./device-api.server";

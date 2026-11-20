import { sameSecret, validWebhook } from "./payment-security.server";
import { createSessionSchema, sessionIdSchema } from "./payments";

const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers":
        "content-type, authorization, x-razorpay-signature, x-device-key",
    },
  });

function requireDevice(request: Request) {
  const incoming = request.headers.get("x-device-key");
  const expected = process.env["DEVICE_API_KEY"];
  if (!expected || !sameSecret(incoming, expected)) {
    return json({ error: "Device authentication required" }, 401);
  }
  return null;
}

const razorpayFetch = (path: string, body: unknown) => {
  const keyId = process.env["RAZORPAY_KEY_ID"];
  const keySecret = process.env["RAZORPAY_KEY_SECRET"];
  if (!keyId || !keySecret) throw new Error("Razorpay not configured");
  return fetch(`https://api.razorpay.com/v1${path}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${keyId}:${keySecret}`)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
};

// ─── Legacy/Compatibility: createSession ───
export async function createSession(request: Request) {
  const denied = requireDevice(request);
  if (denied) return denied;

  const parsed = createSessionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: "Invalid payment request" }, 400);

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { slot, amount_inr } = parsed.data;

  const { data: session, error } = await supabaseAdmin
    .from("parking_sessions")
    .insert({ slot, amount_inr })
    .select()
    .single();

  if (error || !session) return json({ error: "Database rejected session" }, 500);

  try {
    const expire_by = Math.floor(Date.parse(session.created_at) / 1000) + 900;
    const response = await razorpayFetch("/payment_links", {
      amount: amount_inr * 100,
      currency: "INR",
      accept_partial: false,
      reference_id: session.id,
      description: `Parking slot ${slot}`,
      expire_by,
      notes: { session_id: session.id, slot },
    });

    if (!response.ok) {
      await supabaseAdmin
        .from("parking_sessions")
        .update({ status: "expired" })
        .eq("id", session.id);
      return json({ error: "Razorpay could not create the payment link" }, 502);
    }

    const { id: payment_link_id, short_url } = await response.json();
    await supabaseAdmin
      .from("parking_sessions")
      .update({ payment_link_id, short_url })
      .eq("id", session.id);
    return json({ session_id: session.id, short_url });
  } catch {
    await supabaseAdmin.from("parking_sessions").update({ status: "expired" }).eq("id", session.id);
    return json({ error: "Razorpay could not create the payment link" }, 502);
  }
}

// ─── Legacy/Compatibility: sessionStatus ───
export async function sessionStatus(request: Request) {
  const denied = requireDevice(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const parsed = sessionIdSchema.safeParse(url.searchParams.get("id"));
  if (!parsed.success) return json({ error: "Invalid session id" }, 400);

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin.rpc("consume_parking_session", { p_id: parsed.data });

  if (error || !data) return json({ error: "Session missing or expired" }, 404);
  return json({ status: data });
}

// ─── Shared Idempotent markPaidServer ───
export async function markPaidServer(
  orderId: string,
  paymentId: string,
  amountPaise: number,
): Promise<{ status: string; message?: string }> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data: payment, error: pErr } = await supabaseAdmin
    .from("payments")
    .select("*, sessions(*)")
    .eq("razorpay_order_id", orderId)
    .maybeSingle();

  if (pErr || !payment) {
    return { status: "error", message: `Payment record not found for order ${orderId}` };
  }

  if (payment.status === "captured" && payment.razorpay_payment_id === paymentId) {
    return { status: "already_captured" };
  }

  const session = payment.sessions;
  const now = new Date();
  const nowIso = now.toISOString();

  if (!session) {
    await supabaseAdmin
      .from("payments")
      .update({ status: "needs_refund", razorpay_payment_id: paymentId })
      .eq("id", payment.id);

    await supabaseAdmin.from("activity_logs").insert({
      type: "needs_refund",
      message: `Payment ₹${amountPaise / 100} (${paymentId}) received with no valid session. Needs refund.`,
    });
    return { status: "needs_refund" };
  }

  // Validate that paid amount matches payment record
  if (payment.amount_paise && amountPaise && payment.amount_paise !== amountPaise) {
    await supabaseAdmin
      .from("payments")
      .update({ status: "needs_refund", razorpay_payment_id: paymentId })
      .eq("id", payment.id);

    await supabaseAdmin.from("activity_logs").insert({
      type: "needs_refund",
      slot: session.slot,
      session_id: session.id,
      message: `Payment ₹${amountPaise / 100} (${paymentId}) amount mismatch with order ₹${payment.amount_paise / 100}. Needs refund.`,
    });
    return { status: "needs_refund" };
  }

  const isExpired = session.expires_at
    ? new Date(session.expires_at).getTime() < now.getTime()
    : false;

  if (payment.kind === "new" && session.status === "pending" && !isExpired) {
    const { data: updatedSession } = await supabaseAdmin
      .from("sessions")
      .update({
        status: "paid",
        duration_min: payment.duration_min,
        amount_paise: payment.amount_paise,
        paid_at: nowIso,
      })
      .eq("id", session.id)
      .eq("status", "pending")
      .select("id, slot, code")
      .maybeSingle();

    if (updatedSession) {
      await supabaseAdmin
        .from("payments")
        .update({ status: "captured", razorpay_payment_id: paymentId })
        .eq("id", payment.id);

      await supabaseAdmin.from("activity_logs").insert({
        device_id: session.device_id,
        type: "payment_received",
        slot: session.slot,
        session_id: session.id,
        message: `Payment ₹${amountPaise / 100} received for slot ${session.slot} (code: ${session.code})`,
      });

      return { status: "captured" };
    }
  }

  if (payment.kind === "extend" && session.status === "active" && !session.exit_signalled_at) {
    const currentEnd = session.end_time ? new Date(session.end_time).getTime() : now.getTime();
    const newEndIso = new Date(currentEnd + payment.duration_min * 60 * 1000).toISOString();
    const newDuration = (session.duration_min || 0) + payment.duration_min;
    const newAmount = (session.amount_paise || 0) + payment.amount_paise;

    const { data: updatedSession } = await supabaseAdmin
      .from("sessions")
      .update({
        end_time: newEndIso,
        duration_min: newDuration,
        amount_paise: newAmount,
        reminder_sent: false,
      })
      .eq("id", session.id)
      .eq("status", "active")
      .is("exit_signalled_at", null)
      .select("id, slot, code")
      .maybeSingle();

    if (updatedSession) {
      await supabaseAdmin
        .from("payments")
        .update({ status: "captured", razorpay_payment_id: paymentId })
        .eq("id", payment.id);

      await supabaseAdmin.from("activity_logs").insert({
        device_id: session.device_id,
        type: "extend",
        slot: session.slot,
        session_id: session.id,
        message: `Extended by ${payment.duration_min} min (code: ${session.code})`,
      });

      return { status: "captured" };
    }
  }

  await supabaseAdmin
    .from("payments")
    .update({ status: "needs_refund", razorpay_payment_id: paymentId })
    .eq("id", payment.id);

  await supabaseAdmin.from("activity_logs").insert({
    device_id: session.device_id,
    type: "needs_refund",
    slot: session.slot,
    session_id: session.id,
    message: `Payment ₹${amountPaise / 100} (${paymentId}) received for ${session.status} session ${session.code}. Needs refund.`,
  });

  return { status: "needs_refund" };
}

// ─── POST /api/public/razorpay-webhook ───
export async function razorpayWebhook(request: Request): Promise<Response> {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return json({ error: "RAZORPAY_WEBHOOK_SECRET not configured" }, 500);

  const rawBody = await request.text();
  const signature =
    request.headers.get("x-razorpay-signature") || request.headers.get("X-Razorpay-Signature");

  if (!signature || !validWebhook(rawBody, signature, secret)) {
    return json({ error: "Invalid signature" }, 401);
  }

  let event: Record<string, any>;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const eventType = event.event;
  const payload = event.payload || {};

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  // Handle payment_link.paid (legacy support)
  if (eventType === "payment_link.paid") {
    const plink = payload.payment_link?.entity;
    if (!plink || plink.status !== "paid") return json({ error: "Ignored" }, 400);

    const { data: session } = await supabaseAdmin
      .from("parking_sessions")
      .select("*")
      .eq("payment_link_id", plink.id)
      .single();

    if (!session) return json({ error: "Session missing" }, 404);
    if (plink.amount_paid !== session.amount_inr * 100) {
      return json({ error: "Amount mismatch" }, 400);
    }

    // Only update if currently pending
    await supabaseAdmin
      .from("parking_sessions")
      .update({ status: "paid", paid_at: new Date().toISOString() })
      .eq("id", session.id)
      .in("status", ["pending"]);

    return json({ ok: true });
  }

  if (eventType === "payment.captured" || eventType === "order.paid") {
    const paymentEntity = payload.payment?.entity;
    const orderEntity = payload.order?.entity;
    const orderId = paymentEntity?.order_id || orderEntity?.id;
    const paymentId = paymentEntity?.id;
    const amount = paymentEntity?.amount || orderEntity?.amount;

    if (orderId && paymentId && amount) {
      await markPaidServer(orderId, paymentId, Number(amount));
    }
  } else if (eventType === "payment.failed") {
    const paymentEntity = payload.payment?.entity;
    const orderId = paymentEntity?.order_id;
    const paymentId = paymentEntity?.id;
    const errorDescription = paymentEntity?.error_description || "Payment failed";

    if (orderId) {
      await supabaseAdmin
        .from("payments")
        .update({ status: "failed", razorpay_payment_id: paymentId })
        .eq("razorpay_order_id", orderId);

      await supabaseAdmin.from("activity_logs").insert({
        type: "payment_failed",
        message: `Payment failed for order ${orderId}: ${errorDescription}`,
      });
    }
  }

  return json({ status: "ok" }, 200);
}

// ─── POST /api/public/stripe-webhook ───
export async function stripeWebhook(request: Request): Promise<Response> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return json({ error: "STRIPE_WEBHOOK_SECRET not configured" }, 500);

  const rawBody = await request.text();
  const sigHeader =
    request.headers.get("stripe-signature") || request.headers.get("Stripe-Signature");

  if (!sigHeader) {
    return json({ error: "Missing stripe-signature header" }, 401);
  }

  // Parse t=timestamp,v1=signature
  const parts = sigHeader.split(",");
  let timestamp = "";
  let signature = "";
  for (const part of parts) {
    const [k, v] = part.trim().split("=");
    if (k === "t") timestamp = v;
    if (k === "v1") signature = v;
  }

  if (!timestamp || !signature) {
    return json({ error: "Invalid stripe-signature format" }, 401);
  }

  const { createHmac } = await import("crypto");
  const expectedSig = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");

  if (!sameSecret(signature, expectedSig)) {
    return json({ error: "Invalid signature" }, 401);
  }

  let event: Record<string, any>;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const eventType = event.type;
  const dataObject = event.data?.object || {};

  if (eventType === "payment_intent.succeeded" || eventType === "checkout.session.completed") {
    const orderId = dataObject.metadata?.order_id || dataObject.id;
    const paymentId = dataObject.id;
    const amount = dataObject.amount || dataObject.amount_total;

    if (orderId && paymentId && amount) {
      await markPaidServer(orderId, paymentId, Number(amount));
    }
  }

  return json({ received: true }, 200);
}

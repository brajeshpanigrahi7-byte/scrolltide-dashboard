import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { constantTimeCompare, hmacSha256Hex } from "../_shared/crypto.ts";
import { markPaid } from "../_shared/payment.ts";
import { getSupabaseAdmin } from "../_shared/supabase.ts";
import { jsonResponse } from "../_shared/utils.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, corsHeaders);
  }

  const signature = req.headers.get("x-razorpay-signature")?.trim();
  const webhookSecret = Deno.env.get("RAZORPAY_WEBHOOK_SECRET");

  if (!webhookSecret) {
    console.error("RAZORPAY_WEBHOOK_SECRET not set");
    return jsonResponse({ error: "Webhook secret not configured" }, 500, corsHeaders);
  }

  // Read raw body text first for signature verification
  const rawBody = await req.text();

  const expectedSignature = await hmacSha256Hex(rawBody, webhookSecret);
  if (!constantTimeCompare(signature, expectedSignature)) {
    console.error("Invalid Razorpay webhook signature");
    return jsonResponse({ error: "Invalid signature" }, 400, corsHeaders);
  }

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400, corsHeaders);
  }

  const eventType = typeof event.event === "string" ? event.event : "";
  const payload = (event.payload || {}) as Record<string, any>;
  const supabase = getSupabaseAdmin();

  console.log(`[Razorpay Webhook] Received event: ${eventType}`);

  if (eventType === "payment.captured" || eventType === "order.paid") {
    const paymentEntity = payload.payment?.entity;
    const orderEntity = payload.order?.entity;

    const orderId = paymentEntity?.order_id || orderEntity?.id;
    const paymentId = paymentEntity?.id;
    const amount = paymentEntity?.amount || orderEntity?.amount;

    if (orderId && paymentId && amount) {
      await markPaid(supabase, orderId, paymentId, Number(amount));
    }
  } else if (eventType === "payment.failed") {
    const paymentEntity = payload.payment?.entity;
    const orderId = paymentEntity?.order_id;
    const paymentId = paymentEntity?.id;
    const errorDescription = paymentEntity?.error_description || "Payment failed";

    if (orderId) {
      await supabase
        .from("payments")
        .update({
          status: "failed",
          razorpay_payment_id: paymentId,
        })
        .eq("razorpay_order_id", orderId);

      await supabase.from("activity_logs").insert({
        type: "payment_failed",
        message: `Payment failed for order ${orderId}: ${errorDescription}`,
      });
    }
  }

  return jsonResponse({ status: "ok" }, 200, corsHeaders);
});

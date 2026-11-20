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

  let body: {
    razorpay_order_id?: string;
    razorpay_payment_id?: string;
    razorpay_signature?: string;
  };

  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders);
  }

  const orderId = body.razorpay_order_id?.trim();
  const paymentId = body.razorpay_payment_id?.trim();
  const signature = body.razorpay_signature?.trim();

  if (!orderId || !paymentId || !signature) {
    return jsonResponse({ error: "Missing required Razorpay fields" }, 400, corsHeaders);
  }

  const keySecret = Deno.env.get("RAZORPAY_KEY_SECRET");
  if (!keySecret) {
    return jsonResponse({ error: "Razorpay secret not configured" }, 500, corsHeaders);
  }

  // Verify HMAC_SHA256(order_id + "|" + payment_id, KEY_SECRET)
  const expectedSignature = await hmacSha256Hex(`${orderId}|${paymentId}`, keySecret);
  if (!constantTimeCompare(signature, expectedSignature)) {
    return jsonResponse({ error: "Invalid signature" }, 400, corsHeaders);
  }

  // NOTE: Parking access activation is moved out of client-facing payment screen.
  // Access is triggered exclusively via verified server-side payment webhooks (Razorpay/Stripe).
  // verifyPayment confirms cryptographic signature validity without granting access directly.
  return jsonResponse(
    {
      ok: true,
      verified: true,
      message: "Signature verified. Parking access activation is processed via server webhook.",
    },
    200,
    corsHeaders,
  );
});

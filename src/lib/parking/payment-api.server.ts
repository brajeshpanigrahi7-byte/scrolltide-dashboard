import { validWebhook } from "./payment-security.server";

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function razorpayWebhook(request: Request) {
  const raw = await request.text();
  if (!validWebhook(raw, request.headers.get("x-razorpay-signature"), process.env["RAZORPAY_WEBHOOK_SECRET"])) {
    return json({ error: "Invalid signature" }, 400);
  }
  let body: any;
  try { body = JSON.parse(raw); } catch { return json({ error: "Invalid payment event" }, 400); }
  const event = body?.event;
  if (!["payment.captured", "order.paid", "payment.failed"].includes(event)) return json({ received: true });
  const payment = body?.payload?.payment?.entity;
  const order = body?.payload?.order?.entity;
  const orderId = payment?.order_id ?? order?.id;
  if (typeof orderId !== "string") return json({ error: "Missing order" }, 400);
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  if (event === "payment.failed") {
    const { data: record } = await supabaseAdmin.from("payments").update({ status: "failed" })
      .eq("razorpay_order_id", orderId).eq("status", "created").select("session_id").maybeSingle();
    if (record) {
      const { data: session } = await supabaseAdmin.from("sessions").select("device_id,slot").eq("id", record.session_id).single();
      await supabaseAdmin.from("activity_logs").insert({
        device: session?.device_id ?? "webhook", event: "payment_failed", device_id: session?.device_id ?? null,
        type: "payment_failed", session_id: record.session_id, slot: session?.slot ?? null,
        message: "Razorpay payment failed",
      });
    }
    return json({ received: true });
  }

  const amount = event === "order.paid" ? order?.amount_paid : payment?.amount;
  if (!Number.isInteger(amount)) return json({ error: "Missing amount" }, 400);
  const { data: result, error } = await supabaseAdmin.rpc("mark_paid", {
    p_order_id: orderId,
    p_payment_id: (payment?.id ?? null) as string,
    p_amount: amount,
  });
  if (error) return json({ error: "Payment confirmation could not be saved" }, 500);
  if (["not_found", "amount_mismatch", "duplicate_payment"].includes(result)) {
    return json({ error: "Payment validation failed" }, 400);
  }
  return json({ received: true, result });
}

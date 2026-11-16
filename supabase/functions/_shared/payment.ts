import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

export async function markPaid(
  supabase: SupabaseClient,
  orderId: string,
  paymentId: string,
  amountPaise: number
): Promise<{ status: "captured" | "already_captured" | "needs_refund" | "error"; message?: string }> {
  // 1. Find payments row by order id
  const { data: payment, error: pErr } = await supabase
    .from("payments")
    .select("*, sessions(*)")
    .eq("razorpay_order_id", orderId)
    .maybeSingle();

  if (pErr || !payment) {
    return { status: "error", message: `Payment record not found for order ${orderId}` };
  }

  // Idempotent: already captured
  if (payment.status === "captured" && payment.razorpay_payment_id === paymentId) {
    return { status: "already_captured" };
  }

  // Require amount to match
  if (payment.amount_paise !== amountPaise) {
    console.error(`Amount mismatch for order ${orderId}: expected ${payment.amount_paise}, got ${amountPaise}`);
  }

  const session = payment.sessions;
  const now = new Date();
  const nowIso = now.toISOString();

  if (!session) {
    // Payment with no associated session -> needs_refund
    await supabase
      .from("payments")
      .update({
        status: "needs_refund",
        razorpay_payment_id: paymentId,
      })
      .eq("id", payment.id);

    await supabase.from("activity_logs").insert({
      type: "needs_refund",
      message: `Payment ₹${amountPaise / 100} (${paymentId}) received with no valid session. Needs refund.`,
    });
    return { status: "needs_refund" };
  }

  const isExpired = session.expires_at ? new Date(session.expires_at).getTime() < now.getTime() : false;

  // Case A: kind 'new', session still pending and not expired
  if (payment.kind === "new" && session.status === "pending" && !isExpired) {
    // Atomically update session to paid
    const { data: updatedSession, error: sErr } = await supabase
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
      await supabase
        .from("payments")
        .update({
          status: "captured",
          razorpay_payment_id: paymentId,
        })
        .eq("id", payment.id);

      await supabase.from("activity_logs").insert({
        device_id: session.device_id,
        type: "payment_received",
        slot: session.slot,
        session_id: session.id,
        message: `Payment ₹${amountPaise / 100} received for slot ${session.slot} (code: ${session.code})`,
      });

      return { status: "captured" };
    }
  }

  // Case B: kind 'extend', session is active and not exit-signalled
  if (payment.kind === "extend" && session.status === "active" && !session.exit_signalled_at) {
    const currentEnd = session.end_time ? new Date(session.end_time).getTime() : now.getTime();
    const newEndIso = new Date(currentEnd + payment.duration_min * 60 * 1000).toISOString();
    const newDuration = (session.duration_min || 0) + payment.duration_min;
    const newAmount = (session.amount_paise || 0) + payment.amount_paise;

    const { data: updatedSession } = await supabase
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
      await supabase
        .from("payments")
        .update({
          status: "captured",
          razorpay_payment_id: paymentId,
        })
        .eq("id", payment.id);

      await supabase.from("activity_logs").insert({
        device_id: session.device_id,
        type: "extend",
        slot: session.slot,
        session_id: session.id,
        message: `Extended by ${payment.duration_min} min (code: ${session.code})`,
      });

      return { status: "captured" };
    }
  }

  // In any other case: mark needs_refund
  await supabase
    .from("payments")
    .update({
      status: "needs_refund",
      razorpay_payment_id: paymentId,
    })
    .eq("id", payment.id);

  await supabase.from("activity_logs").insert({
    device_id: session.device_id,
    type: "needs_refund",
    slot: session.slot,
    session_id: session.id,
    message: `Payment ₹${amountPaise / 100} (${paymentId}) received for ${session.status} session ${session.code}. Needs refund.`,
  });

  return { status: "needs_refund" };
}

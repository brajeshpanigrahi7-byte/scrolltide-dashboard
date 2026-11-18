import { generateCode, payUrl, RATE_PER_30MIN } from "./payments";

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function createTestPayment(request: Request) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  // Pick slot 1 or any slot 1-5
  const slot = 1;
  const amount_inr = RATE_PER_30MIN; // Rs 20

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
  if (!code) return json({ error: "Could not generate code" }, 500);

  const { data: session, error } = await supabaseAdmin
    .from("parking_sessions")
    .insert({
      slot,
      amount_inr,
      duration_min: 30,
      status: "awaiting_payment",
      code,
    })
    .select()
    .single();

  if (error || !session) return json({ error: "Could not create test session" }, 500);

  const keyId = process.env["RAZORPAY_KEY_ID"];
  const keySecret = process.env["RAZORPAY_KEY_SECRET"];
  let shortUrl: string | null = null;

  if (keyId && keySecret) {
    const expire_by = Math.floor(Date.now() / 1000) + 30 * 60; // 30 minutes in future (integer Unix seconds)
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
          description: `Test payment slot ${session.slot}`,
          expire_by,
          notes: {
            session_id: session.id,
            slot: session.slot,
            code,
            test: true,
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
        const errorBody = await response.text();
        console.error("Razorpay create-link rejected for test payment:", response.status, errorBody);

        try {
          await supabaseAdmin.from("activity_logs").insert({
            device: "test-dashboard",
            event: "link_creation_failed",
            session_id: session.id,
            slot: session.slot,
            meta: { status: response.status, error: errorBody },
          });
        } catch (logErr) {
          console.error("Failed to write to activity_logs", logErr);
        }

        // Fallback to Orders API
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
                test: true,
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
          }
        } catch (orderErr) {
          console.error("Razorpay order creation fallback failed", orderErr);
        }
      }
    } catch (linkErr) {
      console.error("Payment Link creation request threw:", linkErr);
    }
  }

  const pay_url = payUrl(code);

  return json({
    session_id: session.id,
    code,
    pay_url,
    short_url: shortUrl,
  });
}

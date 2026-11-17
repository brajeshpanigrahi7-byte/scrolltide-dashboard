import { generateCode, payUrl } from "./payments";

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function createTestPayment(request: Request) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    const { data: session, error } = await supabaseAdmin.rpc("create_device_session", {
      p_device: "dashboard-test",
      p_slot: 1,
      p_code: code,
    });
    if (!error && session) {
      return json({
        session_id: session.id,
        code: session.code,
        pay_url: payUrl(session.code, process.env["PUBLIC_APP_URL"]),
        short_url: null,
      }, 201);
    }
    if (error?.message.includes("SLOT_UNAVAILABLE")) {
      return json({ error: "Slot 1 already has an active session" }, 409);
    }
    if (error?.code !== "23505") {
      console.error("Dashboard test session creation failed", error?.message);
      return json({ error: "Could not create test session" }, 500);
    }
  }
  return json({ error: "Could not allocate a unique code" }, 500);
}

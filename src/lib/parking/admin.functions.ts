import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function assertAdmin(context: { supabase: any; userId: string }) {
  const { data, error } = await context.supabase
    .from("user_roles").select("id").eq("user_id", context.userId).eq("role", "admin").maybeSingle();
  if (error || !data) throw new Error("Admin access required");
}

export const getConnectionStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const keyId = process.env["RAZORPAY_KEY_ID"] ?? "";
    return {
      razorpayMode: keyId.startsWith("rzp_live_") ? "live" : keyId.startsWith("rzp_test_") ? "test" : "not_configured",
      deviceKeyConfigured: Boolean(process.env["DEVICE_API_KEY"]),
      appUrl: process.env["PUBLIC_APP_URL"] ?? "https://scrolltide-dashboard.lovable.app",
    };
  });

export const updateParkingSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({
    price_per_hour: z.number().positive().max(10000),
    duration_options: z.array(z.number().int().min(5).max(1440)).min(1).max(12)
      .refine((values) => new Set(values).size === values.length, "Durations must be unique"),
    reminder_min: z.number().int().min(1).max(120),
    exit_open_seconds: z.number().int().min(5).max(300),
    offline_after_s: z.number().int().min(5).max(600),
  }))
  .handler(async ({ context, data }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("settings").update({
      ...data,
      duration_options: [...data.duration_options].sort((a, b) => a - b),
    }).eq("id", true);
    if (error) throw new Error("Could not save settings");
    return { ok: true };
  });

export const openExitGate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ device_id: z.string().min(1).max(64) }))
  .handler(async ({ context, data }) => {
    await assertAdmin(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: existing } = await supabaseAdmin.from("device_commands").select("id")
      .eq("device_id", data.device_id).eq("command", "open_exit").is("consumed_at", null).maybeSingle();
    if (existing) return { ok: true, alreadyQueued: true };
    const { error } = await supabaseAdmin.from("device_commands").insert({
      device_id: data.device_id, command: "open_exit",
    });
    if (error) throw new Error("Could not queue exit command");
    return { ok: true, alreadyQueued: false };
  });

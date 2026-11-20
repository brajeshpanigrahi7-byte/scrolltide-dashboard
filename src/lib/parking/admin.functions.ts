import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { generateCode } from "./payments";

export async function assertAdmin(context: { supabase: any; userId: string }) {
  if (!context?.userId) throw new Error("Authentication required");

  // Check role using RPC has_role (1-arg version: checks auth.uid() server-side)
  try {
    const { data: hasRole, error: rpcErr } = await context.supabase.rpc("has_role", {
      required_role: "admin",
    });
    if (!rpcErr && typeof hasRole === "boolean") {
      if (!hasRole) throw new Error("Admin access required");
      return;
    }
  } catch (err: any) {
    if (err.message === "Admin access required") throw err;
  }

  // Fallback to direct user_roles check (strict check: null or non-admin throws)
  const { data: roleRow, error } = await context.supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", context.userId)
    .maybeSingle();

  if (error || !roleRow || roleRow.role !== "admin") {
    throw new Error("Admin access required");
  }
}

export async function getServerDb() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    const missing = [
      ...(!url ? ["SUPABASE_URL"] : []),
      ...(!key ? ["SUPABASE_SERVICE_ROLE_KEY"] : []),
    ];
    console.error(
      `[Admin Server DB] Missing Supabase environment variable(s): ${missing.join(", ")}`,
    );
    throw new Error("server_not_configured");
  }

  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    if (supabaseAdmin && typeof (supabaseAdmin as any).from === "function") {
      return supabaseAdmin;
    }
  } catch {}

  const { createClient } = await import("@supabase/supabase-js");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export const getConnectionStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const keyId = process.env["RAZORPAY_KEY_ID"] ?? "";
    return {
      razorpayMode: keyId.startsWith("rzp_live_")
        ? "live"
        : keyId.startsWith("rzp_test_")
          ? "test"
          : "not_configured",
      deviceKeyConfigured: Boolean(process.env["DEVICE_API_KEY"]),
      appUrl: process.env["PUBLIC_APP_URL"] ?? "https://scrolltide-dashboard.lovable.app",
    };
  });

export const updateParkingSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    z.object({
      price_per_hour: z.number().positive().max(10000),
      duration_options: z
        .array(z.number().int().min(5).max(1440))
        .min(1)
        .max(12)
        .refine((values) => new Set(values).size === values.length, "Durations must be unique"),
      reminder_min: z.number().int().min(1).max(120),
      exit_open_seconds: z.number().int().min(5).max(300),
      offline_after_s: z.number().int().min(5).max(600),
    }),
  )
  .handler(async ({ context, data }) => {
    await assertAdmin(context);
    const db = await getServerDb();
    const { error } = await db
      .from("settings")
      .update({
        ...data,
        duration_options: [...data.duration_options].sort((a, b) => a - b),
      })
      .eq("id", 1);
    if (error) throw new Error("Could not save settings");
    return { ok: true };
  });

export const openExitGate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ device_id: z.string().min(1).max(64) }))
  .handler(async ({ context, data }) => {
    await assertAdmin(context);
    const db = await getServerDb();
    const { data: existing } = await db
      .from("device_commands")
      .select("id")
      .eq("device_id", data.device_id)
      .eq("command", "open_exit")
      .is("consumed_at", null)
      .maybeSingle();
    if (existing) return { ok: true, alreadyQueued: true };
    const { error } = await db.from("device_commands").insert({
      device_id: data.device_id,
      command: "open_exit",
    });
    if (error) throw new Error(`Could not queue exit command: ${error.message}`);
    return { ok: true, alreadyQueued: false };
  });

export const createAdminTestSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    z.object({
      device_id: z.string().default("esp32-entry-1"),
      slot: z.number().int().min(1).max(5).default(1),
    }),
  )
  .handler(async ({ context, data }) => {
    await assertAdmin(context);
    const db = await getServerDb();
    const publicAppUrl = (
      process.env.PUBLIC_APP_URL || "https://scrolltide-dashboard.lovable.app"
    ).replace(/\/+$/, "");

    // Generate unique 6-character code (exclusively from 23456789ABCDEFGHJKLMNPQRSTUVWXYZ)
    let code = "";
    for (let i = 0; i < 5; i++) {
      const candidate = generateCode(6);
      const { data: existing } = await db
        .from("sessions")
        .select("id")
        .eq("code", candidate)
        .maybeSingle();

      if (!existing) {
        code = candidate;
        break;
      }
    }

    if (!code) throw new Error("Could not generate session code");

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const { data: newSession, error: createErr } = await db
      .from("sessions")
      .insert({
        device_id: data.device_id,
        slot: data.slot,
        status: "pending",
        code,
        expires_at: expiresAt,
      })
      .select("id, code, slot")
      .single();

    if (createErr || !newSession) {
      throw new Error(createErr?.message || "Failed to create admin test session");
    }

    try {
      await db.from("activity_logs").insert({
        device_id: data.device_id,
        type: "session_created",
        slot: data.slot,
        session_id: newSession.id,
        message: `Admin created test session ${code} for slot ${data.slot}`,
      });
    } catch {}

    let payUrl = `${publicAppUrl}/pay/${code}`;
    if (payUrl.length > 53) {
      payUrl = `/pay/${code}`;
    }

    return {
      session_id: newSession.id,
      code: newSession.code,
      slot: newSession.slot,
      pay_url: payUrl,
    };
  });

export const adminCleanStaleSessions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const { cleanStaleSessions } = await import("./device-api.server");
    return cleanStaleSessions();
  });

export const updateUserRoleOrBalance = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    z.object({
      target_user_id: z.string().uuid(),
      role: z.enum(["admin", "operator", "user"]).optional(),
      balance: z.number().optional(),
      rewards: z.number().optional(),
    }),
  )
  .handler(async ({ context, data }) => {
    // Enforce strict server-side authentication and verify caller has admin role
    await assertAdmin(context);

    // Ensure regular users cannot update their own role, balance, or rewards
    if (context.userId === data.target_user_id && data.role && data.role !== "admin") {
      throw new Error("Cannot demote own admin role");
    }

    const db = await getServerDb();
    if (data.role) {
      const { error } = await db
        .from("user_roles")
        .upsert({ user_id: data.target_user_id, role: data.role }, { onConflict: "user_id" });
      if (error) throw new Error(`Could not update user role: ${error.message}`);
    }

    return { ok: true };
  });

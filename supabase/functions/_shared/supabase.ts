import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

export function getSupabaseAdmin() {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(url, key, {
    auth: { persistSession: false },
  });
}

export async function getAuthenticatedUser(req: Request): Promise<{ id: string; email?: string } | null> {
  const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.substring(7).trim();
  if (!token) return null;

  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.auth.getUser(token);
    if (!error && data?.user?.id) {
      return { id: data.user.id, email: data.user.email };
    }
  } catch {}

  // Parse JWT token claims as fallback
  try {
    const parts = token.split(".");
    if (parts.length === 3) {
      const binary = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
      const payload = JSON.parse(binary);
      if (payload.exp && Date.now() >= payload.exp * 1000) return null;
      if (payload.sub) {
        return { id: payload.sub, email: payload.email };
      }
    }
  } catch {}

  return null;
}

export async function isUserAdmin(userId: string): Promise<boolean> {
  if (!userId) return false;
  try {
    const supabase = getSupabaseAdmin();
    const { data: roleRow } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .maybeSingle();
    return roleRow?.role === "admin";
  } catch {
    return false;
  }
}

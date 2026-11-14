import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { useParking } from "./store";
import { todayCollected } from "./payments";

export type ParkingSession = Database["public"]["Tables"]["parking_sessions"]["Row"];
const Context = createContext({ rows: [] as ParkingSession[], total: 0, error: null as string | null, signedIn: false, loading: true });
export function SessionsProvider({ children }: { children: ReactNode }) {
  const { mode } = useParking();
  const [rows, setRows] = useState<ParkingSession[]>([]);
  const [signedIn, setSignedIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(0);
  useEffect(() => {
    let active = true;
    const load = async () => {
      const { data: auth } = await supabase.auth.getSession();
      if (!active) return;
      setSignedIn(Boolean(auth.session));
      if (!auth.session) { setRows([]); setLoading(false); return; }
      const operator = await supabase.from("parking_operators").select("user_id").eq("user_id", auth.session.user.id).maybeSingle();
      if (!operator.data) { setError("Your account needs operator access."); setLoading(false); return; }
      const all: ParkingSession[] = [];
      for (let start = 0; ; start += 1000) {
        const result = await supabase.from("parking_sessions").select("*").order("created_at", { ascending: false }).range(start, start + 999);
        if (result.error) { if (active) setError(result.error.message); break; }
        all.push(...result.data);
        if (result.data.length < 1000) { if (active) { setRows(all); setError(null); } break; }
      }
      if (active) { setLoading(false); setNow(Date.now()); }
    };
    void load();
    const { data: listener } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") { setRows([]); setSignedIn(false); setError(null); }
      if (event === "SIGNED_IN" || event === "USER_UPDATED") setTimeout(() => void load(), 0);
    });
    const channel = supabase.channel(`parking-sessions-${crypto.randomUUID()}`).on("postgres_changes", { event: "*", schema: "public", table: "parking_sessions" }, () => void load()).subscribe();
    const timer = setInterval(() => { setNow(Date.now()); void load(); }, 30000);
    return () => { active = false; listener.subscription.unsubscribe(); void supabase.removeChannel(channel); clearInterval(timer); };
  }, []);
  return <Context.Provider value={{ rows: mode === "demo" ? [] : rows, total: mode === "demo" ? 0 : todayCollected(rows, now), signedIn, error, loading }}>{children}</Context.Provider>;
}
export const useSessions = () => useContext(Context);
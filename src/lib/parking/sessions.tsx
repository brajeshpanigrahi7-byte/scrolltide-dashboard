import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { useParking } from "./store";
import { todayCollected } from "./payments";

export type ParkingSession = Database["public"]["Tables"]["sessions"]["Row"];
export type ParkingPayment = Database["public"]["Tables"]["payments"]["Row"];

type SessionsContext = {
  rows: ParkingSession[];
  payments: ParkingPayment[];
  total: number;
  error: string | null;
  signedIn: boolean;
  loading: boolean;
};

const Context = createContext<SessionsContext>({
  rows: [], payments: [], total: 0, error: null, signedIn: false, loading: true,
});

export function SessionsProvider({ children }: { children: ReactNode }) {
  const { mode } = useParking();
  const [rows, setRows] = useState<ParkingSession[]>([]);
  const [payments, setPayments] = useState<ParkingPayment[]>([]);
  const [signedIn, setSignedIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    let loadingRows = false;
    const load = async () => {
      if (loadingRows) return;
      loadingRows = true;
      try {
        const { data: auth } = await supabase.auth.getSession();
        if (!active) return;
        setSignedIn(Boolean(auth.session));
        if (!auth.session) {
          setRows([]); setPayments([]); setError(null); setLoading(false); return;
        }
        const admin = await supabase.from("user_roles").select("id")
          .eq("user_id", auth.session.user.id).eq("role", "admin").maybeSingle();
        if (!active) return;
        if (admin.error || !admin.data) {
          setRows([]); setPayments([]);
          setError(admin.error ? "Could not verify admin access." : "Your account needs the admin role.");
          setLoading(false); return;
        }
        const [sessionResult, paymentResult] = await Promise.all([
          supabase.from("sessions").select("*").order("created_at", { ascending: false }).limit(5000),
          supabase.from("payments").select("*").order("created_at", { ascending: false }).limit(5000),
        ]);
        if (!active) return;
        if (sessionResult.error || paymentResult.error) {
          setError("Could not load live parking records. Retrying shortly.");
        } else {
          setRows(sessionResult.data);
          setPayments(paymentResult.data);
          setError(null);
        }
        setLoading(false);
      } catch {
        if (active) { setError("Could not connect to live parking records."); setLoading(false); }
      } finally { loadingRows = false; }
    };
    void load();
    const channel = supabase.channel(`live-payments-${crypto.randomUUID()}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "sessions" }, () => void load())
      .subscribe();
    const timer = setInterval(() => void load(), 15000);
    return () => { active = false; void supabase.removeChannel(channel); clearInterval(timer); };
  }, []);

  return <Context.Provider value={{
    rows: mode === "demo" ? [] : rows,
    payments: mode === "demo" ? [] : payments,
    total: mode === "demo" ? 0 : todayCollected(payments, Date.now()),
    signedIn, error, loading,
  }}>{children}</Context.Provider>;
}

export const useSessions = () => useContext(Context);

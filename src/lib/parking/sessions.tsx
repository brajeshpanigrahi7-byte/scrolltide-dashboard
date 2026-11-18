import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useParking } from "./store";

<<<<<<< HEAD
export interface ParkingSessionRow {
  id: string;
  code: string;
  slot: number;
  status: "pending" | "paid" | "active" | "completed" | "expired" | "cancelled" | string;
  duration_min: number;
  amount_inr: number;
  vehicle_no?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  created_at: string;
  expires_at?: string | null;
  paid_at?: string | null;
  entered_at?: string | null;
  end_time?: string | null;
  exit_signalled_at?: string | null;
}

interface SessionsContextType {
  rows: ParkingSessionRow[];
=======
export type ParkingSession = Database["public"]["Tables"]["sessions"]["Row"];
export type ParkingPayment = Database["public"]["Tables"]["payments"]["Row"];

type SessionsContext = {
  rows: ParkingSession[];
  payments: ParkingPayment[];
>>>>>>> origin/main
  total: number;
  error: string | null;
  signedIn: boolean;
  loading: boolean;
<<<<<<< HEAD
  signInWithEmail: (email: string, password?: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const Context = createContext<SessionsContextType>({
  rows: [],
  total: 0,
  error: null,
  signedIn: false,
  loading: true,
  signInWithEmail: async () => ({ error: null }),
  signOut: async () => {},
  refresh: async () => {},
=======
};

const Context = createContext<SessionsContext>({
  rows: [], payments: [], total: 0, error: null, signedIn: false, loading: true,
>>>>>>> origin/main
});

export function SessionsProvider({ children }: { children: ReactNode }) {
  const { mode } = useParking();
<<<<<<< HEAD
  const [rows, setRows] = useState<ParkingSessionRow[]>([]);
  const [signedIn, setSignedIn] = useState(true); // default true for dashboard view
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);

  const loadSessions = async () => {
    try {
      // 1. Fetch sessions from sessions table
      let { data: sessionsData, error: sessErr } = await supabase
        .from("sessions")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(100);

      if (sessErr) {
        // Fallback to legacy parking_sessions if sessions table has not yet migrated
        const { data: legData } = await supabase
          .from("parking_sessions")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(100);

        if (legData) {
          sessionsData = legData.map((s: any) => ({
            id: s.id,
            code: s.code || s.id.slice(0, 6).toUpperCase(),
            slot: s.slot,
            status: s.status,
            duration_min: s.duration_min || 30,
            amount_inr: s.amount_inr || 20,
            created_at: s.created_at,
            paid_at: s.paid_at,
            entered_at: s.entered_at,
            end_time: s.ends_at,
          }));
        }
      }

      if (sessionsData) {
        const mapped: ParkingSessionRow[] = sessionsData.map((s: any) => ({
          id: s.id,
          code: s.code || "—",
          slot: s.slot,
          status: s.status,
          duration_min: s.duration_min || 0,
          amount_inr: s.amount_paise ? Math.round(s.amount_paise / 100) : (s.amount_inr || 0),
          vehicle_no: s.vehicle_no,
          contact_email: s.contact_email,
          contact_phone: s.contact_phone,
          created_at: s.created_at,
          expires_at: s.expires_at,
          paid_at: s.paid_at,
          entered_at: s.entered_at,
          end_time: s.end_time || s.ends_at,
          exit_signalled_at: s.exit_signalled_at,
        }));

        setRows(mapped);

        // Calculate today's collected in IST
        const now = Date.now();
        const offsetMs = 330 * 60 * 1000;
        const startOfDayIst = Math.floor((now + offsetMs) / 86400000) * 86400000 - offsetMs;

        const todaySum = mapped
          .filter((s) => {
            const paidAtMs = s.paid_at ? Date.parse(s.paid_at) : 0;
            return (
              (s.status === "paid" || s.status === "active" || s.status === "completed") &&
              paidAtMs >= startOfDayIst
            );
          })
          .reduce((acc, curr) => acc + curr.amount_inr, 0);

        setTotal(todaySum);
        setError(null);
      }
    } catch (e: any) {
      setError(e.message || "Failed to load sessions");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let active = true;

    // Check user auth
    supabase.auth.getSession().then(({ data }) => {
      if (active) {
        setSignedIn(Boolean(data.session));
      }
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_, session) => {
      if (active) {
        setSignedIn(Boolean(session));
        loadSessions();
      }
    });

    loadSessions();

    // Subscribe to realtime updates on sessions and payments
    const channel = supabase
      .channel(`sessions-realtime-${crypto.randomUUID()}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "sessions" }, () => {
        loadSessions();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "parking_sessions" }, () => {
        loadSessions();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "payments" }, () => {
        loadSessions();
      })
      .subscribe();

    const interval = setInterval(loadSessions, 5000);

    return () => {
      active = false;
      listener.subscription.unsubscribe();
      supabase.removeChannel(channel);
      clearInterval(interval);
    };
  }, []);

  const signInWithEmail = async (email: string, password?: string) => {
    try {
      if (password) {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        return { error: error ? error.message : null };
      }
      const { error } = await supabase.auth.signInWithOtp({ email });
      return { error: error ? error.message : null };
    } catch (e: any) {
      return { error: e.message || "Sign in failed" };
    }
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setSignedIn(false);
  };

  return (
    <Context.Provider
      value={{
        rows: mode === "demo" ? [] : rows,
        total: mode === "demo" ? 0 : total,
        signedIn,
        error,
        loading,
        signInWithEmail,
        signOut,
        refresh: loadSessions,
      }}
    >
      {children}
    </Context.Provider>
  );
=======
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
>>>>>>> origin/main
}

export const useSessions = () => useContext(Context);

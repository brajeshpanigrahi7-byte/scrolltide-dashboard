import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { createInitialState, log, triggerExit, tick } from "./engine";
import type { LogCategory, LogEvent, ParkingState, Severity } from "./types";

export type Mode = "demo" | "live";

interface Ctx {
  state: ParkingState;
  mode: Mode;
  setDemoMode: (demo: boolean) => void;
  liveError: string | null;
  autoDemo: boolean;
  setAutoDemo: (v: boolean) => void;
  actions: {
    vehicleArrives: () => void;
    parkAssigned: () => void;
    setIr: (slot: number, present: boolean) => void;
    leaveSlot: (slot?: number) => void;
    triggerExit: () => void;
    pressBoot: () => void;
    toggleSensor: (slot: number | "us") => void;
    reset: () => void;
  };
}

const ParkingCtx = createContext<Ctx | null>(null);

export function ParkingProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<Mode>("live");
  const setDemoMode = (demo: boolean) => setMode(demo ? "demo" : "live");
  const [state, setState] = useState<ParkingState>(() => createInitialState(Date.now()));
  const [liveError, setLiveError] = useState<string | null>(null);
  const [autoDemo, setAutoDemo] = useState(true);
  const ref = useRef(state);
  ref.current = state;
  const arrivalUntil = useRef(0);

  // Demo engine loop (100 ms, like the firmware HC-SR04 poll)
  useEffect(() => {
    if (mode !== "demo") return;
    setState(() => {
      const now = Date.now();
      const s = createInitialState(now);
      // Two vehicles already parked at boot for a realistic starting picture
      for (const id of [2, 4]) {
        const sl = s.slots[id - 1]!;
        sl.irRaw = true;
        sl.status = "OCCUPIED";
      }
      return s;
    });
    const t = setInterval(() => {
      setState((prev) => {
        const now = Date.now();
        const arriving = now < arrivalUntil.current;
        const base = arriving ? 8 + Math.random() * 3 : 110 + Math.random() * 25;
        const next = tick({ ...prev, distanceCm: prev.usOk ? base : prev.distanceCm }, now);
        return next;
      });
    }, 100);
    return () => clearInterval(t);
  }, [mode]);

  // Live mode: reads ESP32 online/offline, 5 slots, sessions, telemetry, and logs from Supabase
  useEffect(() => {
    if (mode !== "live") return;
    let active = true;

    const pullLiveDevice = async () => {
      try {
        const now = Date.now();

        // 1. Fetch settings
        const { data: settingsData } = await supabase
          .from("settings")
          .select("*")
          .eq("id", 1)
          .maybeSingle();

        const offlineAfterS = settingsData?.offline_after_s ?? 30;

        // 2. Fetch device
        const { data: devData, error: devErr } = await supabase
          .from("devices")
          .select("*")
          .order("last_seen", { ascending: false })
          .limit(1)
          .maybeSingle();

        let device: any = devData;

        if (devErr && !device) {
          // Fallback check esp32_devices if legacy
          const { data: legDevice } = await supabase
            .from("esp32_devices")
            .select("*")
            .order("last_seen_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (legDevice) {
            device = {
              id: legDevice.device,
              last_seen: legDevice.last_seen_at,
              rssi: -65,
              uptime_s: 120,
              entry_state: 0,
              exit_open: false,
            };
          }
        }

        const lastSeenMs = device?.last_seen ? Date.parse(device.last_seen) : 0;
        const isOnline = Boolean(device && now - lastSeenMs <= offlineAfterS * 1000);
        const entryStateNum = device?.entry_state ?? 0;
        const exitOpen = Boolean(device?.exit_open);

        // 3. Fetch slots
        const { data: slotsData } = await supabase
          .from("slots")
          .select("*")
          .order("slot", { ascending: true });

        // 4. Fetch active & pending sessions
        const { data: sessionsData } = await supabase
          .from("sessions")
          .select("*")
          .in("status", ["pending", "paid", "active"])
          .order("created_at", { ascending: false });

        // 5. Fetch telemetry history
        const { data: telemetryData } = await supabase
          .from("device_telemetry")
          .select("*")
          .order("ts", { ascending: false })
          .limit(60);

        const latestDistance = telemetryData && telemetryData[0]?.dist_cm != null
          ? Number(telemetryData[0].dist_cm)
          : 120;

        // 6. Fetch recent activity logs
        const { data: logsData } = await supabase
          .from("activity_logs")
          .select("*")
          .order("ts", { ascending: false })
          .limit(50);

        // 7. Calculate today's revenue (IST)
        const offsetMs = 330 * 60 * 1000;
        const startOfDayIst = Math.floor((now + offsetMs) / 86400000) * 86400000 - offsetMs;

        const { data: paymentsData } = await supabase
          .from("payments")
          .select("amount_paise, created_at, status")
          .eq("status", "captured")
          .gte("created_at", new Date(startOfDayIst).toISOString());

        const todayRevenueInr = (paymentsData ?? []).reduce(
          (sum: number, p: any) => sum + Math.round((p.amount_paise || 0) / 100),
          0
        );

        if (!active) return;

        const activeSessions = (sessionsData ?? []).filter((s: any) => s.status === "active");
        const pendingSession = (sessionsData ?? []).find(
          (s: any) => s.status === "pending" && Date.parse(s.expires_at) > now
        );

        const mappedLogs: LogEvent[] = (logsData ?? []).map((l: any, idx: number) => ({
          id: idx + 1,
          ts: Date.parse(l.ts || l.created_at || new Date().toISOString()),
          category: (l.type === "entered" || l.type === "session_created"
            ? "entry"
            : l.type === "exit_opened" || l.type === "leave_now"
            ? "exit"
            : l.type === "slot_change"
            ? "slot"
            : "system") as LogCategory,
          message: l.message || `${l.type} event`,
          severity: (l.type === "needs_refund"
            ? "error"
            : l.type === "payment_received" || l.type === "exit_opened"
            ? "success"
            : l.type === "reminder_sent"
            ? "warning"
            : "info") as Severity,
          slot: l.slot ?? undefined,
        }));

        setState((prev) => {
          const next = {
            ...prev,
            now,
            online: isOnline,
            rssi: device?.rssi ?? null,
            uptime_s: device?.uptime_s ?? null,
            lastSeenMs,
            entryStateNum,
            exitOpen,
            distanceCm: isOnline ? latestDistance : prev.distanceCm,
            activeSessions,
            pendingSession: pendingSession || null,
            todayRevenueInr,
            settings: settingsData || null,
          };

          if (mappedLogs.length > 0) next.logs = mappedLogs;

          // Map 5 slots
          next.slots = prev.slots.map((s, idx) => {
            const slotNum = idx + 1;
            const slotDb = slotsData?.find((sd: any) => sd.slot === slotNum);
            const activeSess = activeSessions.find((as: any) => as.slot === slotNum);
            const pendingSess = sessionsData?.find(
              (ps: any) => ps.slot === slotNum && ps.status === "pending" && Date.parse(ps.expires_at) > now
            );

            let status: "FREE" | "RESERVED" | "OCCUPIED" = "FREE";
            if (activeSess) {
              status = "OCCUPIED";
            } else if (pendingSess) {
              status = "RESERVED";
            } else if (slotDb?.occupied) {
              status = "OCCUPIED";
            }

            const isOccupied = status === "OCCUPIED";
            const secondsRemaining = activeSess?.end_time
              ? Math.max(0, Math.floor((Date.parse(activeSess.end_time) - now) / 1000))
              : null;

            return {
              ...s,
              status,
              irRaw: isOccupied,
              lastUpdate: slotDb?.updated_at ? Date.parse(slotDb.updated_at) : (lastSeenMs || now),
              sensorOk: true,
              sessionCode: activeSess?.code || pendingSess?.code || null,
              vehicleNo: activeSess?.vehicle_no || null,
              secondsRemaining,
              endsAt: activeSess?.end_time || null,
              reservedUntil: pendingSess?.expires_at ? Date.parse(pendingSess.expires_at) : null,
            };
          });

          // OLED display simulation
          next.oled = isOnline
            ? entryStateNum === 1
              ? ["WAITING PAYMENT", pendingSession ? `SLOT ${pendingSession.slot}` : "SCAN QR"]
              : entryStateNum === 2
              ? ["BARRIER OPEN", "PROCEED TO SLOT"]
              : entryStateNum === 3
              ? ["PARKING FULL", "NO FREE SLOTS"]
              : ["PARKSENSE LIVE", "SYSTEM READY"]
            : ["DEVICE OFFLINE", "WAITING ESP32"];

          return next;
        });

        setLiveError(null);
      } catch (err: any) {
        if (active) setLiveError(err.message || "Could not read ESP32 device status");
      }
    };

    void pullLiveDevice();

    // Subscribe to realtime database updates
    const channel = supabase
      .channel(`parksense-realtime-${crypto.randomUUID()}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "devices" }, () => {
        void pullLiveDevice();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "slots" }, () => {
        void pullLiveDevice();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "sessions" }, () => {
        void pullLiveDevice();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "payments" }, () => {
        void pullLiveDevice();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "device_telemetry" }, () => {
        void pullLiveDevice();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "activity_logs" }, () => {
        void pullLiveDevice();
      })
      .subscribe();

    // Re-check online condition every 3 seconds
    const interval = setInterval(() => {
      void pullLiveDevice();
    }, 3000);

    return () => {
      active = false;
      void supabase.removeChannel(channel);
      clearInterval(interval);
    };
  }, [mode]);

  const mutate = (fn: (s: ParkingState) => ParkingState) =>
    mode === "demo" && setState((p) => fn({ ...p, slots: p.slots.map((x) => ({ ...x })) }));

  const actions: Ctx["actions"] = {
    vehicleArrives: () => {
      arrivalUntil.current = Date.now() + 1400;
    },
    parkAssigned: () =>
      mutate((s) => {
        const target =
          s.slots.find((x) => x.status === "RESERVED") ?? s.slots.find((x) => x.status === "FREE");
        if (target) target.irRaw = true;
        return s;
      }),
    setIr: (slot, present) =>
      mutate((s) => {
        s.slots[slot - 1]!.irRaw = present;
        return s;
      }),
    leaveSlot: (slot) =>
      mutate((s) => {
        const target = slot
          ? s.slots[slot - 1]
          : s.slots.find((x) => x.status === "OCCUPIED" && x.irRaw);
        if (target) {
          target.irRaw = false;
          s.exitStage = "leaves";
          s.stageTimes = { ...s.stageTimes, leaves: Date.now() };
        }
        return s;
      }),
    triggerExit: () => mode === "demo" && setState((p) => triggerExit(p, Date.now())),
    pressBoot: () => mode === "demo" && setState((p) => triggerExit(p, Date.now())),
    toggleSensor: (slot) =>
      mutate((s) => {
        s.now = Date.now();
        if (slot === "us") {
          s.usOk = !s.usOk;
          log(
            s,
            "sensor",
            s.usOk
              ? "HC-SR04 communication restored"
              : "HC-SR04 communication failure (no echo)",
            s.usOk ? "success" : "error",
          );
        } else {
          const sl = s.slots[slot - 1]!;
          sl.sensorOk = !sl.sensorOk;
          log(
            s,
            "sensor",
            sl.sensorOk
              ? `IR sensor ${slot} restored`
              : `IR sensor ${slot} communication failure`,
            sl.sensorOk ? "success" : "error",
            slot,
          );
        }
        return s;
      }),
    reset: () => mode === "demo" && setState(createInitialState(Date.now())),
  };

  // Auto demo script — cycles through the real workflow
  useEffect(() => {
    if (mode !== "demo" || !autoDemo) return;
    const t = setInterval(() => {
      const s = ref.current;
      if (s.entryPhase !== "IDLE") return;
      const reserved = s.slots.find((x) => x.status === "RESERVED" && !x.irRaw);
      const occ = s.slots.filter((x) => x.status === "OCCUPIED" && x.irRaw);
      const r = Math.random();
      if (reserved && r < 0.7) actions.parkAssigned();
      else if (occ.length >= 4 || (occ.length > 0 && r < 0.35)) {
        actions.triggerExit();
        setTimeout(() => actions.leaveSlot(), 2500);
      } else actions.vehicleArrives();
    }, 9000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, autoDemo]);

  return (
    <ParkingCtx.Provider
      value={{ state, mode, setDemoMode, liveError, autoDemo, setAutoDemo, actions }}
    >
      {children}
    </ParkingCtx.Provider>
  );
}

export function useParking() {
  const c = useContext(ParkingCtx);
  if (!c) throw new Error("useParking outside provider");
  return c;
}

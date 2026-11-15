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

  // Live mode: reads ESP32 online/offline and 5 slots from esp32_devices table
  useEffect(() => {
    if (mode !== "live") return;
    let active = true;

    const pullLiveDevice = async () => {
      try {
        const { data: device, error } = await supabase
          .from("esp32_devices")
          .select("*")
          .order("last_seen_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (!active) return;
        if (error) {
          setLiveError(error.message);
          return;
        }

        const now = Date.now();
        const lastSeenMs = device?.last_seen_at ? Date.parse(device.last_seen_at) : 0;
        // last_seen_at within 30 s = online
        const isOnline = Boolean(device && now - lastSeenMs <= 30_000);
        const occupancy = device?.slot_occupancy || "00000";

        // Also fetch recent activity logs
        const { data: logsData } = await supabase
          .from("activity_logs")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(50);

        if (!active) return;

        const mappedLogs: LogEvent[] = (logsData ?? []).map((l, idx) => ({
          id: idx + 1,
          ts: Date.parse(l.created_at),
          category: (l.event === "entered" ? "entry" : l.event === "slots" ? "slot" : "system") as LogCategory,
          message:
            l.event === "heartbeat"
              ? `ESP32 heartbeat (${l.device})`
              : l.event === "slots"
              ? `Occupancy update: ${l.occupancy}`
              : l.event === "entered"
              ? `Vehicle entered slot ${l.slot}`
              : l.event === "session_created"
              ? `Payment session initiated for slot ${l.slot}`
              : l.event === "payment_received"
              ? `Payment confirmed for slot ${l.slot}`
              : l.event === "session_expired"
              ? `Session ended for slot ${l.slot} — exit gate opened`
              : `${l.device}: ${l.event}`,
          severity: (l.event === "payment_received" || l.event === "session_expired"
            ? "success"
            : l.event === "link_creation_failed"
            ? "error"
            : "info") as Severity,
          slot: l.slot ?? undefined,
        }));

        setState((prev) => {
          const next = { ...prev, now, online: isOnline };
          if (mappedLogs.length > 0) next.logs = mappedLogs;
          next.slots = prev.slots.map((s, idx) => {
            // slot_occupancy like "10110" = slots 1-5 occupied
            const isOccupied = occupancy[idx] === "1";
            return {
              ...s,
              status: isOccupied ? "OCCUPIED" : "FREE",
              irRaw: isOccupied,
              lastUpdate: lastSeenMs || now,
              sensorOk: true,
            };
          });
          next.oled = isOnline
            ? ["PARKSENSE LIVE", "SYSTEM READY"]
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
      .channel(`esp32-live-${crypto.randomUUID()}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "esp32_devices" }, () => {
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

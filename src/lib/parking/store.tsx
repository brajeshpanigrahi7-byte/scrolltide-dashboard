import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createInitialState, log, pressBoot, tick } from "./engine";
import type { ParkingState } from "./types";
import { getLiveConfig, subscribeLive } from "./live";

export type Mode = "demo" | "live";

interface Ctx {
  state: ParkingState;
  mode: Mode;
  liveError: string | null;
  autoDemo: boolean;
  setAutoDemo: (v: boolean) => void;
  actions: {
    vehicleArrives: () => void;
    parkAssigned: () => void;
    setIr: (slot: number, present: boolean) => void;
    leaveSlot: (slot?: number) => void;
    pressBoot: () => void;
    toggleSensor: (slot: number | "us") => void;
    reset: () => void;
  };
}

const ParkingCtx = createContext<Ctx | null>(null);

export function ParkingProvider({ children }: { children: ReactNode }) {
  const live = getLiveConfig();
  const mode: Mode = live ? "live" : "demo";
  const [state, setState] = useState<ParkingState>(() => createInitialState(0));
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
      for (const id of [2, 4]) { const sl = s.slots[id - 1]!; sl.irRaw = true; sl.status = "OCCUPIED"; }
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

  // Live mode: Firebase Realtime Database stream
  useEffect(() => {
    if (!live) return;
    return subscribeLive(live, (s) => { setState(s); setLiveError(null); }, (e) => setLiveError(e));
  }, [live?.dbUrl]);

  const mutate = (fn: (s: ParkingState) => ParkingState) => mode === "demo" && setState((p) => fn({ ...p, slots: p.slots.map((x) => ({ ...x })) }));

  const actions: Ctx["actions"] = {
    vehicleArrives: () => { arrivalUntil.current = Date.now() + 1400; },
    parkAssigned: () => mutate((s) => {
      const target = s.slots.find((x) => x.status === "RESERVED") ?? s.slots.find((x) => x.status === "FREE");
      if (target) target.irRaw = true;
      return s;
    }),
    setIr: (slot, present) => mutate((s) => { s.slots[slot - 1]!.irRaw = present; return s; }),
    leaveSlot: (slot) => mutate((s) => {
      const target = slot ? s.slots[slot - 1] : s.slots.find((x) => x.status === "OCCUPIED" && x.irRaw);
      if (target) {
        target.irRaw = false;
        s.exitStage = "leaves"; s.stageTimes = { ...s.stageTimes, leaves: Date.now() };
      }
      return s;
    }),
    pressBoot: () => mode === "demo" && setState((p) => pressBoot(p, Date.now())),
    toggleSensor: (slot) => mutate((s) => {
      s.now = Date.now();
      if (slot === "us") {
        s.usOk = !s.usOk;
        log(s, "sensor", s.usOk ? "HC-SR04 communication restored" : "HC-SR04 communication failure (no echo)", s.usOk ? "success" : "error");
      } else {
        const sl = s.slots[slot - 1]!;
        sl.sensorOk = !sl.sensorOk;
        log(s, "sensor", sl.sensorOk ? `IR sensor ${slot} restored` : `IR sensor ${slot} communication failure`, sl.sensorOk ? "success" : "error", slot);
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
      else if (occ.length >= 4 || (occ.length > 0 && r < 0.35)) { actions.pressBoot(); setTimeout(() => actions.leaveSlot(), 2500); }
      else actions.vehicleArrives();
    }, 9000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, autoDemo]);

  return (
    <ParkingCtx.Provider value={{ state, mode, liveError, autoDemo, setAutoDemo, actions }}>
      {children}
    </ParkingCtx.Provider>
  );
}

export function useParking() {
  const c = useContext(ParkingCtx);
  if (!c) throw new Error("useParking outside provider");
  return c;
}

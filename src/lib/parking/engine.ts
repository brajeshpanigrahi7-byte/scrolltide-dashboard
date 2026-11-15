// Pure re-implementation of the smart_parking state machines, used by DEMO MODE.
import { TIMING, type LogCategory, type ParkingState, type Severity, type Slot } from "./types";

let logId = 1;

export function createInitialState(now: number): ParkingState {
  const slots: Slot[] = [1, 2, 3, 4, 5].map((id) => ({
    id,
    status: "FREE",
    irRaw: false,
    irPendingSince: null,
    reservedUntil: null,
    lastUpdate: now,
    sensorOk: true,
  }));
  const s: ParkingState = {
    now,
    bootedAt: now,
    online: true,
    slots,
    distanceCm: 120,
    usOk: true,
    detectCount: 0,
    entryPhase: "IDLE",
    entryServo: 0,
    assignedSlot: null,
    qrShownAt: null,
    clearSince: null,
    welcomeUntil: null,
    entryStage: "scan",
    exitPhase: "IDLE",
    exitServo: 0,
    exitCloseAt: null,
    exitStage: "idle",
    exitSignalledAt: null,
    paymentAt: null,
    oled: ["SMART PARKING", "READY"],
    buzzerUntil: 0,
    stageTimes: {},
    logs: [],
    counters: { entries: 0, exits: 0, full: 0, irEvents: 0, usDetections: 0 },
    history: [],
  };
  for (const st of ["power", "init", "splash", "scan"]) s.stageTimes[st] = now;
  log(s, "system", "ESP32 online — scanning 5 parking slots", "info");
  return s;
}

export function log(
  s: ParkingState,
  category: LogCategory,
  message: string,
  severity: Severity = "info",
  slot?: number,
) {
  s.logs = [{ id: logId++, ts: s.now, category, message, severity, slot }, ...s.logs].slice(0, 300);
}

function stage(s: ParkingState, key: string, which: "entry" | "exit" = "entry") {
  if (which === "entry") s.entryStage = key;
  else s.exitStage = key;
  s.stageTimes[key] = s.now;
}

export const counts = (s: Pick<ParkingState, "slots">) => ({
  free: s.slots.filter((x) => x.status === "FREE").length,
  reserved: s.slots.filter((x) => x.status === "RESERVED").length,
  occupied: s.slots.filter((x) => x.status === "OCCUPIED").length,
});

/** Occupancy % counts only OCCUPIED slots, never RESERVED. */
export const occupancyPct = (s: Pick<ParkingState, "slots">) => (counts(s).occupied / 5) * 100;

/** Advance all state machines to time `now`. Mutates a clone and returns it. */
export function tick(prev: ParkingState, now: number): ParkingState {
  const s: ParkingState = {
    ...prev,
    now,
    slots: prev.slots.map((x) => ({ ...x })),
    counters: { ...prev.counters },
    stageTimes: { ...prev.stageTimes },
  };

  // ---- IR slots: 2 s stable detection ----
  for (const slot of s.slots) {
    if (!slot.sensorOk) continue;
    const stableOccupied = slot.status === "OCCUPIED";
    if (slot.irRaw !== stableOccupied) {
      if (slot.irPendingSince === null) slot.irPendingSince = now;
      else if (now - slot.irPendingSince >= TIMING.irDebounceMs) {
        slot.irPendingSince = null;
        slot.lastUpdate = now;
        s.counters.irEvents++;
        if (slot.irRaw) {
          slot.status = "OCCUPIED";
          slot.reservedUntil = null;
          log(s, "slot", `Slot ${slot.id} became OCCUPIED — LED red`, "warning", slot.id);
          if (s.assignedSlot === slot.id || s.entryStage === "welcome" || s.entryStage === "parks")
            stage(s, "occupied");
        } else {
          slot.status = "FREE";
          log(s, "slot", `Slot ${slot.id} became FREE — LED green`, "success", slot.id);
          if (s.exitStage === "leaves" || s.exitStage === "closed") stage(s, "freed", "exit");
        }
      }
    } else slot.irPendingSince = null;

    if (slot.status === "RESERVED" && slot.reservedUntil !== null && now >= slot.reservedUntil) {
      slot.status = "FREE";
      slot.reservedUntil = null;
      slot.lastUpdate = now;
      log(s, "slot", `Reservation for slot ${slot.id} expired (60 s) — LED green`, "warning", slot.id);
    }
  }

  // ---- Entry HC-SR04 state machine ----
  const d = s.distanceCm;
  switch (s.entryPhase) {
    case "IDLE":
      if (!s.usOk) break;
      if (d < TIMING.detectCm) {
        s.detectCount++;
        if (s.detectCount === 1) {
          s.entryPhase = "DETECTING";
          stage(s, "check_us");
        }
      } else s.detectCount = 0;
      break;
    case "DETECTING":
      if (d < TIMING.detectCm) s.detectCount++;
      else {
        s.detectCount = 0;
        s.entryPhase = "IDLE";
        stage(s, "scan");
        break;
      }
      if (s.detectCount >= TIMING.detectReadings) {
        s.counters.usDetections++;
        stage(s, "detected");
        log(s, "entry", `Vehicle detected at entry (${d.toFixed(1)} cm, 5 readings)`, "info");
        const free = s.slots.find((x) => x.status === "FREE");
        if (!free) {
          s.entryPhase = "FULL";
          s.oled = ["PARKING FULL", "SORRY"];
          s.buzzerUntil = now + 900;
          s.counters.full++;
          stage(s, "full");
          log(s, "entry", "Parking FULL — three beeps, entry barrier stays closed", "error");
        } else {
          free.status = "RESERVED";
          free.reservedUntil = now + TIMING.reserveMs;
          free.lastUpdate = now;
          s.assignedSlot = free.id;
          s.qrShownAt = now;
          s.entryServo = 90;
          s.clearSince = null;
          s.entryPhase = "GATE_OPEN";
          s.oled = [`SLOT ${free.id} - PAY Rs20`, "[ QR CODE ]"];
          s.counters.entries++;
          stage(s, "allocate");
          stage(s, "reserve");
          stage(s, "qr");
          stage(s, "gate_open");
          log(s, "slot", `Slot ${free.id} reserved for 60 s — LED yellow`, "info", free.id);
          log(s, "entry", `Payment QR displayed on OLED for slot ${free.id}`, "info", free.id);
          log(s, "entry", "Entry barrier opened (servo 90°)", "success", free.id);
        }
      }
      break;
    case "GATE_OPEN":
      if (d > TIMING.clearCm) {
        if (s.clearSince === null) {
          s.clearSince = now;
          stage(s, "passes");
        }
      } else s.clearSince = null;
      if (
        s.clearSince !== null &&
        now - s.clearSince >= TIMING.clearHoldMs &&
        s.qrShownAt !== null &&
        now - s.qrShownAt >= TIMING.minQrMs
      ) {
        stage(s, "clear");
        s.entryServo = 0;
        s.entryPhase = "WELCOME";
        s.welcomeUntil = now + TIMING.welcomeMs;
        s.oled = ["WELCOME!", `GO TO SLOT ${s.assignedSlot}`];
        stage(s, "gate_close");
        stage(s, "welcome");
        log(s, "entry", "Entry barrier closed (servo 0°)", "info", s.assignedSlot ?? undefined);
      }
      break;
    case "WELCOME":
      if (s.welcomeUntil !== null && now >= s.welcomeUntil) {
        s.entryPhase = "IDLE";
        s.welcomeUntil = null;
        s.detectCount = 0;
        s.oled = ["SMART PARKING", "READY"];
        stage(s, "parks");
      }
      break;
    case "FULL":
      if (d > TIMING.clearCm) {
        s.entryPhase = "IDLE";
        s.detectCount = 0;
        s.oled = ["SMART PARKING", "READY"];
        stage(s, "scan");
      }
      break;
  }

  // ---- Exit: session expiry triggered ----
  if (s.exitPhase === "OPEN" && s.exitCloseAt !== null && now >= s.exitCloseAt) {
    s.exitPhase = "IDLE";
    s.exitServo = 0;
    s.exitCloseAt = null;
    s.oled = ["SMART PARKING", "READY"];
    stage(s, "closed", "exit");
    log(s, "exit", "Exit barrier closed (servo 0° after 60 s)", "info");
  }

  if (!prev.history.length || now - prev.history[prev.history.length - 1]!.t >= 5000) {
    s.history = [...prev.history, { t: now, ...counts(s) }].slice(-120);
  }
  return s;
}

/** Exit workflow: session time over → dashboard signals ESP32 → exit servo opens for 60 s. */
export function triggerExit(prev: ParkingState, now: number): ParkingState {
  if (prev.exitPhase === "OPEN") return prev;
  const s: ParkingState = {
    ...prev,
    now,
    counters: { ...prev.counters, exits: prev.counters.exits + 1 },
    stageTimes: { ...prev.stageTimes },
  };
  s.exitSignalledAt = now;
  s.paymentAt = now;
  s.exitPhase = "OPEN";
  s.exitServo = 90;
  s.exitCloseAt = now + TIMING.exitOpenMs; // 60 seconds
  s.oled = ["SESSION OVER", "GATE OPEN 60S"];
  s.buzzerUntil = now + 500;
  for (const k of ["time_over", "signal", "open"]) stage(s, k, "exit");
  log(
    s,
    "exit",
    "Session time over — dashboard signalled ESP32, exit servo open for 60 s",
    "success",
  );
  return s;
}

// Keep backward compatibility alias if any test imports pressBoot
export const pressBoot = triggerExit;

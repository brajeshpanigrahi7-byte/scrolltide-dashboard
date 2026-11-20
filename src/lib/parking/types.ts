export type SlotStatus = "FREE" | "RESERVED" | "OCCUPIED";

export interface Slot {
  id: number; // 1..5
  status: SlotStatus;
  irRaw: boolean; // instantaneous IR reading (true = vehicle)
  irPendingSince: number | null; // when raw first differed from stable state (2 s debounce)
  reservedUntil: number | null;
  lastUpdate: number;
  sensorOk: boolean;
  sessionCode?: string | null;
  vehicleNo?: string | null;
  secondsRemaining?: number | null;
  endsAt?: string | null;
}

export type EntryPhase = "IDLE" | "DETECTING" | "GATE_OPEN" | "WELCOME" | "FULL";
export type ExitPhase = "IDLE" | "OPEN";
export type LogCategory = "entry" | "exit" | "slot" | "sensor" | "system";
export type Severity = "info" | "success" | "warning" | "error";

export interface LogEvent {
  id: number;
  ts: number;
  category: LogCategory;
  message: string;
  slot?: number | undefined;
  severity: Severity;
}

export interface ParkingState {
  now: number;
  bootedAt: number;
  online: boolean;
  slots: Slot[];
  distanceCm: number;
  usOk: boolean;
  detectCount: number;
  entryPhase: EntryPhase;
  entryServo: 0 | 90;
  assignedSlot: number | null;
  qrShownAt: number | null;
  clearSince: number | null;
  welcomeUntil: number | null;
  entryStage: string;
  exitPhase: ExitPhase;
  exitServo: 0 | 90;
  exitCloseAt: number | null;
  exitStage: string;
  exitSignalledAt: number | null;
  paymentAt: number | null;
  oled: [string, string];
  buzzerUntil: number;
  stageTimes: Record<string, number>;
  logs: LogEvent[];
  counters: {
    entries: number;
    exits: number;
    full: number;
    irEvents: number;
    usDetections: number;
  };
  history: { t: number; free: number; reserved: number; occupied: number }[];
  rssi?: number | null;
  uptime_s?: number | null;
  lastSeenMs?: number | null;
  entryStateNum?: number;
  exitOpen?: boolean;
  activeSessions?: any[];
  pendingSession?: any | null;
  todayRevenueInr?: number;
  settings?: any;
  telemetryHistory?: { ts: number; dist_cm: number }[];
  authRequired?: boolean;
  authError?: string | null;
}

export const QR_TEXT = "upi://pay?pa=smartparking@upi&am=20&cu=INR";
export const QR_AMOUNT = 20;

export const TIMING = {
  usIntervalMs: 100,
  detectCm: 15,
  clearCm: 20,
  detectReadings: 5,
  reserveMs: 60_000,
  minQrMs: 5_000,
  clearHoldMs: 1_500,
  welcomeMs: 3_000,
  irDebounceMs: 2_000,
  exitOpenMs: 60_000, // Exit servo opens for 60 s
} as const;

export const GPIO = {
  oledSda: 21,
  oledScl: 22,
  trig: 5,
  echo: 18,
  entryServo: 13,
  exitServo: 27,
  buzzer: 4,
  ir: [34, 35, 36, 39, 32],
  led: [
    [25, 26],
    [33, 14],
    [16, 17],
    [19, 12],
    [15, 2],
  ] as [number, number][],
};

// Live mode: reads the state the ESP32 publishes to Firebase Realtime Database.
// Read-only from the browser — device writes are protected by database rules (see docs/FIREBASE_SETUP.md).
import { createInitialState } from "./engine";
import type { ParkingState } from "./types";

export interface LiveConfig { dbUrl: string; authToken?: string }

export function getLiveConfig(): LiveConfig | null {
  const dbUrl = import.meta.env.VITE_FIREBASE_DB_URL as string | undefined;
  if (!dbUrl) return null;
  return { dbUrl: dbUrl.replace(/\/$/, "") };
}

/** Device payload published at /parking (see firmware/firebase_bridge.ino). */
interface DevicePayload {
  lastSeen?: number;
  slots?: { status: ParkingState["slots"][number]["status"]; ir: boolean; reservedUntil?: number; updated?: number; ok?: boolean }[];
  entry?: { distance?: number; usOk?: boolean; phase?: ParkingState["entryPhase"]; servo?: 0 | 90; slot?: number; qrAt?: number; stage?: string };
  exit?: { phase?: ParkingState["exitPhase"]; servo?: 0 | 90; closeAt?: number; paymentAt?: number; stage?: string };
  oled?: [string, string];
  logs?: Record<string, { ts: number; category: ParkingState["logs"][number]["category"]; message: string; severity: ParkingState["logs"][number]["severity"]; slot?: number }>;
  counters?: ParkingState["counters"];
}

export function mapPayload(p: DevicePayload | null, now: number): ParkingState {
  const s = createInitialState(now);
  s.logs = [];
  if (!p) { s.online = false; return s; }
  s.online = !!p.lastSeen && now - p.lastSeen < 15_000;
  p.slots?.slice(0, 5).forEach((x, i) => {
    Object.assign(s.slots[i], { status: x.status, irRaw: x.ir, reservedUntil: x.reservedUntil ?? null, lastUpdate: x.updated ?? now, sensorOk: x.ok ?? true });
  });
  if (p.entry) {
    s.distanceCm = p.entry.distance ?? s.distanceCm; s.usOk = p.entry.usOk ?? true;
    s.entryPhase = p.entry.phase ?? "IDLE"; s.entryServo = p.entry.servo ?? 0;
    s.assignedSlot = p.entry.slot ?? null; s.qrShownAt = p.entry.qrAt ?? null; s.entryStage = p.entry.stage ?? "scan";
  }
  if (p.exit) {
    s.exitPhase = p.exit.phase ?? "IDLE"; s.exitServo = p.exit.servo ?? 0; s.exitCloseAt = p.exit.closeAt ?? null;
    s.paymentAt = p.exit.paymentAt ?? null; s.exitStage = p.exit.stage ?? "idle";
  }
  if (p.oled) s.oled = p.oled;
  if (p.counters) s.counters = p.counters;
  if (p.logs) s.logs = Object.entries(p.logs).map(([k, v], i) => ({ id: i + 1, ...v, slot: v.slot ?? undefined, ...(k ? {} : {}) })).sort((a, b) => b.ts - a.ts);
  return s;
}

export function subscribeLive(cfg: LiveConfig, onState: (s: ParkingState) => void, onError: (e: string) => void) {
  let cancelled = false;
  const pull = async () => {
    try {
      const r = await fetch(`${cfg.dbUrl}/parking.json`);
      if (!r.ok) throw new Error(`Database responded ${r.status}`);
      const data = (await r.json()) as DevicePayload | null;
      if (!cancelled) onState(mapPayload(data, Date.now()));
    } catch (e) {
      if (!cancelled) onError(e instanceof Error ? e.message : "Connection failed");
    }
  };
  pull();
  let es: EventSource | null = null;
  try {
    es = new EventSource(`${cfg.dbUrl}/parking.json`);
    es.addEventListener("put", pull);
    es.addEventListener("patch", pull);
    es.onerror = () => onError("Realtime stream interrupted — retrying");
  } catch { /* fall back to polling */ }
  const poll = setInterval(pull, 5000);
  return () => { cancelled = true; es?.close(); clearInterval(poll); };
}

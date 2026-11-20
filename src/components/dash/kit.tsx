import { QRCodeSVG } from "qrcode.react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  GPIO,
  QR_AMOUNT,
  QR_TEXT,
  TIMING,
  type LogEvent,
  type ParkingState,
  type Slot,
  type SlotStatus,
} from "@/lib/parking/types";
import { Car, CircleDot, Cpu, DoorClosed, DoorOpen } from "lucide-react";

export const fmtTime = (ts: number | null | undefined) =>
  ts
    ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—";
export const ago = (ts: number, now: number) => {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ${s % 60}s ago`;
};

export function Panel({
  title,
  icon,
  action,
  className,
  children,
}: {
  title?: string;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn("panel p-5", className)}>
      {title && (
        <header className="mb-4 flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            {icon}
            {title}
          </h2>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

const tone = {
  free: "text-free",
  reserved: "text-reserved",
  occupied: "text-occupied",
  warning: "text-warning",
  primary: "text-primary",
  muted: "text-muted-foreground",
  error: "text-destructive",
} as const;
export type Tone = keyof typeof tone;

export function Dot({ t, pulse }: { t: Tone; pulse?: boolean | undefined }) {
  return (
    <span
      className={cn(
        "inline-block size-2 rounded-full bg-current",
        tone[t],
        pulse && "animate-pulse-ring",
      )}
    />
  );
}

export function Pill({ t, children, pulse }: { t: Tone; children: ReactNode; pulse?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-current/30 bg-current/10 px-2.5 py-0.5 font-mono text-[11px] font-medium uppercase tracking-wide",
        tone[t],
      )}
    >
      <Dot t={t} pulse={pulse} />
      <span className="text-foreground/90">{children}</span>
    </span>
  );
}

export function StatCard({
  label,
  value,
  sub,
  icon,
  t = "primary",
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon: ReactNode;
  t?: Tone;
}) {
  return (
    <div className="panel relative overflow-hidden p-4">
      <div className="flex items-start justify-between">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
        <span className={cn("rounded-lg bg-current/10 p-1.5", tone[t])}>{icon}</span>
      </div>
      <p className="mt-3 font-mono text-3xl font-semibold tabular-nums">{value}</p>
      {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

export const statusTone: Record<SlotStatus, Tone> = {
  FREE: "free",
  RESERVED: "reserved",
  OCCUPIED: "occupied",
};
const statusLabel: Record<SlotStatus, string> = {
  FREE: "AVAILABLE",
  RESERVED: "RESERVED",
  OCCUPIED: "OCCUPIED",
};
const glow: Record<SlotStatus, string> = {
  FREE: "glow-free",
  RESERVED: "glow-reserved",
  OCCUPIED: "glow-occupied",
};

export function SlotCard({ slot, now, compact }: { slot: Slot; now: number; compact?: boolean }) {
  const isExpiringSoon =
    slot.status === "OCCUPIED" &&
    slot.secondsRemaining != null &&
    slot.secondsRemaining <= 600 &&
    slot.secondsRemaining > 0;

  const t: Tone = isExpiringSoon ? "warning" : statusTone[slot.status];
  const remain = slot.reservedUntil ? Math.max(0, Math.ceil((slot.reservedUntil - now) / 1000)) : 0;
  const [r, g] = GPIO.led[slot.id - 1] ?? [0, 0];

  const formatCountdown = (totalSec: number) => {
    const s = Math.max(0, totalSec);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  return (
    <div
      className={cn(
        "panel relative flex flex-col overflow-hidden border-2 border-dashed transition-colors duration-500",
        t === "free"
          ? "border-free/40"
          : t === "reserved"
            ? "border-reserved/50"
            : isExpiringSoon
              ? "border-warning/70"
              : "border-occupied/50",
      )}
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <span className="font-mono text-xs text-muted-foreground">SLOT {slot.id}</span>
        <span
          className={cn(
            "size-3 rounded-full bg-current transition-all duration-500",
            tone[t],
            isExpiringSoon ? "glow-warning animate-pulse" : glow[slot.status],
          )}
          title={`RGB LED (R:GPIO${r} / G:GPIO${g})`}
        />
      </div>
      <div
        className={cn(
          "flex flex-1 flex-col items-center justify-center gap-1.5",
          compact ? "py-3" : "py-6",
        )}
      >
        <span className="font-mono text-3xl font-bold">{slot.id}</span>
        <Car
          className={cn(
            "transition-all duration-500",
            tone[t],
            slot.status === "OCCUPIED" ? "size-9 opacity-100" : "size-7 opacity-25",
          )}
        />
        <span className={cn("font-mono text-[11px] font-semibold tracking-wider", tone[t])}>
          {isExpiringSoon ? "ENDING SOON" : statusLabel[slot.status]}
        </span>

        {/* Reserved details */}
        {slot.status === "RESERVED" && (
          <div className="w-4/5 text-center mt-1">
            {slot.sessionCode && (
              <span className="inline-block px-2 py-0.5 rounded bg-reserved/10 text-reserved font-mono text-[11px] font-bold">
                {slot.sessionCode}
              </span>
            )}
            <div className="h-1 overflow-hidden rounded-full bg-muted mt-1.5">
              <div
                className="h-full bg-reserved transition-all"
                style={{ width: `${Math.min(100, (remain / 300) * 100)}%` }}
              />
            </div>
            <p className="mt-1 font-mono text-[11px] text-reserved font-medium">
              {formatCountdown(remain)} left
            </p>
          </div>
        )}

        {/* Occupied details */}
        {slot.status === "OCCUPIED" && (
          <div className="w-4/5 text-center mt-1 space-y-0.5">
            {slot.sessionCode && (
              <span className="inline-block px-2 py-0.5 rounded bg-muted font-mono text-[11px] font-semibold text-slate-200">
                {slot.sessionCode}
              </span>
            )}
            {slot.vehicleNo && (
              <p className="font-mono text-[10px] text-muted-foreground uppercase">
                {slot.vehicleNo}
              </p>
            )}
            {slot.secondsRemaining != null && (
              <p
                className={cn(
                  "font-mono text-xs font-bold pt-0.5",
                  isExpiringSoon ? "text-warning animate-pulse" : "text-emerald-400",
                )}
              >
                {formatCountdown(slot.secondsRemaining)}
              </p>
            )}
          </div>
        )}
      </div>

      {!compact && (
        <dl className="grid grid-cols-2 gap-y-1 border-t border-border px-4 py-2.5 font-mono text-[11px]">
          <dt className="text-muted-foreground">IR (GPIO{GPIO.ir[slot.id - 1]})</dt>
          <dd className="text-right">
            {!slot.sensorOk ? (
              <span className="text-destructive">FAULT</span>
            ) : slot.irRaw ? (
              "DETECT"
            ) : (
              "CLEAR"
            )}
          </dd>
          <dt className="text-muted-foreground">LED</dt>
          <dd className={cn("text-right font-medium", tone[t])}>
            {slot.status === "FREE"
              ? "GREEN"
              : slot.status === "RESERVED"
                ? "YELLOW"
                : isExpiringSoon
                  ? "BLINKING"
                  : "RED"}
          </dd>
          <dt className="text-muted-foreground">Updated</dt>
          <dd className="text-right">{fmtTime(slot.lastUpdate)}</dd>
        </dl>
      )}
    </div>
  );
}

export function Legend() {
  return (
    <div className="flex flex-wrap gap-3">
      <Pill t="free">Available</Pill>
      <Pill t="reserved">Reserved · 60 s</Pill>
      <Pill t="occupied">Occupied</Pill>
    </div>
  );
}

const sevTone: Record<LogEvent["severity"], Tone> = {
  info: "primary",
  success: "free",
  warning: "warning",
  error: "error",
};
export function LogList({
  logs,
  limit,
  empty = "No events yet",
}: {
  logs: LogEvent[];
  limit?: number;
  empty?: string;
}) {
  const items = limit ? logs.slice(0, limit) : logs;
  if (!items.length)
    return <p className="py-8 text-center text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="divide-y divide-border">
      {items.map((e) => (
        <li
          key={e.id}
          className="flex items-start gap-3 py-2.5 animate-in fade-in slide-in-from-top-1"
        >
          <span className="mt-1.5">
            <Dot t={sevTone[e.severity]} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm leading-snug">{e.message}</p>
            <p className="mt-0.5 font-mono text-[11px] uppercase text-muted-foreground">
              {fmtTime(e.ts)} · {e.category}
              {e.slot ? ` · slot ${e.slot}` : ""}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function GateVisual({ open, label }: { open: boolean; label: string }) {
  return (
    <div className="flex items-center gap-4">
      <div className="relative h-16 w-28 overflow-hidden rounded-lg bg-surface-2 p-2">
        <div className="absolute bottom-3 left-3 size-3 rounded-full bg-muted-foreground" />
        <div
          className={cn(
            "absolute bottom-[1.05rem] left-[1.1rem] h-1.5 w-20 origin-left rounded-full transition-transform duration-700",
            open ? "bg-free" : "bg-occupied",
          )}
          style={{ transform: `rotate(${open ? -75 : 0}deg)` }}
        />
      </div>
      <div>
        <p className="flex items-center gap-1.5 text-sm font-semibold">
          {open ? (
            <DoorOpen className="size-4 text-free" />
          ) : (
            <DoorClosed className="size-4 text-occupied" />
          )}
          {open ? "OPEN" : "CLOSED"}
        </p>
        <p className="font-mono text-xs text-muted-foreground">
          {label} · servo {open ? 90 : 0}°
        </p>
      </div>
    </div>
  );
}

export function Oled({ lines, qr }: { lines: [string, string]; qr?: boolean }) {
  return (
    <div
      className="rounded-lg border-4 border-surface-2 bg-background p-3"
      title="SSD1306 128×64 OLED (I²C SDA 21 / SCL 22)"
    >
      <div className="flex aspect-[2/1] items-center justify-center gap-3 font-mono text-primary">
        {qr && (
          <div className="rounded bg-foreground p-1">
            <QRCodeSVG value={QR_TEXT} size={52} />
          </div>
        )}
        <div className="text-center">
          <p className="text-sm font-bold">{lines[0]}</p>
          <p className="text-xs opacity-80">{lines[1]}</p>
        </div>
      </div>
    </div>
  );
}

export function QrPanel({ s }: { s: ParkingState }) {
  const active = s.entryPhase === "GATE_OPEN";
  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
      <div
        className={cn("rounded-xl bg-foreground p-3 transition-opacity", !active && "opacity-40")}
      >
        <QRCodeSVG value={QR_TEXT} size={140} />
      </div>
      <dl className="grid flex-1 grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Assigned slot</dt>
        <dd className="font-mono">{s.assignedSlot ?? "—"}</dd>
        <dt className="text-muted-foreground">Amount (QR_TEXT)</dt>
        <dd className="font-mono">₹{QR_AMOUNT}</dd>
        <dt className="text-muted-foreground">QR on OLED</dt>
        <dd>
          {active ? (
            <Pill t="reserved" pulse>
              Showing
            </Pill>
          ) : (
            <Pill t="muted">Hidden</Pill>
          )}
        </dd>
        <dt className="text-muted-foreground">Exit payment</dt>
        <dd>{s.paymentAt ? <Pill t="free">Payment OK</Pill> : <Pill t="muted">Pending</Pill>}</dd>
        <dt className="text-muted-foreground">Confirmed at</dt>
        <dd className="font-mono">{fmtTime(s.paymentAt)}</dd>
        <p className="col-span-2 mt-1 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">
          Demonstration QR only. In live mode, payments are verified via Razorpay webhook.
        </p>
      </dl>
    </div>
  );
}

export const icons = { CircleDot, Cpu };
export { TIMING };

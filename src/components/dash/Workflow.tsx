import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ParkingState } from "@/lib/parking/types";
import { fmtTime } from "./kit";

type Step = { key: string; label: string; hw?: string; branch?: "no" | "yes" };

export const ENTRY_STEPS: Step[] = [
  { key: "power", label: "Power on" },
  { key: "init", label: "ESP32 initialization", hw: "ESP32" },
  { key: "splash", label: "OLED splash + double beep", hw: "OLED · Buzzer" },
  { key: "scan", label: "Scan 5 IR sensors & update slots", hw: "IR ×5" },
  { key: "check_us", label: "Check entry ultrasonic (<15 cm ×5)", hw: "HC-SR04" },
  { key: "detected", label: "Vehicle detected → check free slots", hw: "HC-SR04" },
  { key: "full", label: "NO FREE SLOT: PARKING FULL · 3 beeps · gate stays closed", hw: "OLED · Buzzer", branch: "no" },
  { key: "allocate", label: "Allocate first free slot", branch: "yes" },
  { key: "reserve", label: "Reserve slot 60 s · LED yellow", hw: "RGB LED" },
  { key: "qr", label: "Display payment QR (≥5 s)", hw: "OLED" },
  { key: "gate_open", label: "Entry barrier opens", hw: "Servo GPIO13 → 90°" },
  { key: "passes", label: "Vehicle passes entry", hw: "HC-SR04 >20 cm" },
  { key: "clear", label: "Sensor clear for 1.5 s", hw: "HC-SR04" },
  { key: "gate_close", label: "Entry barrier closes", hw: "Servo GPIO13 → 0°" },
  { key: "welcome", label: "WELCOME + slot number (3 s)", hw: "OLED" },
  { key: "parks", label: "Vehicle parks" },
  { key: "occupied", label: "IR detects · 2 s debounce · OCCUPIED · LED red", hw: "IR · RGB LED" },
];

export const EXIT_STEPS: Step[] = [
  { key: "time_over", label: "Session time over" },
  { key: "signal", label: "Dashboard signals the ESP32", hw: "REST API device-due" },
  { key: "open", label: "Exit servo opens for 60 s", hw: "Servo GPIO27 → 90°" },
  { key: "closed", label: "Exit servo closes", hw: "Servo GPIO27 → 0°" },
  { key: "leaves", label: "Vehicle leaves the parking slot", hw: "IR" },
  { key: "freed", label: "Slot freed · LED green", hw: "IR · RGB LED" },
];

function statusFor(steps: Step[], current: string, key: string) {
  const ci = steps.findIndex((s) => s.key === current);
  const ki = steps.findIndex((s) => s.key === key);
  if (key === current) return "current";
  // FULL branch and YES branch are exclusive
  if (current === "full") return ki < steps.findIndex((s) => s.key === "full") ? "done" : "pending";
  if (key === "full") return "pending";
  return ki < ci ? "done" : "pending";
}

export function WorkflowColumn({ title, steps, current, s, entry }: { title: string; steps: Step[]; current: string; s: ParkingState; entry?: boolean }) {
  return (
    <div className="panel p-5">
      <h3 className="mb-1 text-sm font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
      <p className="mb-5 font-mono text-xs text-muted-foreground">Current: <span className="text-primary">{steps.find((x) => x.key === current)?.label ?? "Idle — waiting"}</span></p>
      <ol className="relative">
        {steps.map((st, i) => {
          const status = entry && current === "scan" && i <= 3 ? (st.key === "scan" ? "current" : "done") : statusFor(steps, current, st.key);
          return (
            <li key={st.key} className={cn("relative flex gap-3 pb-4", st.branch && "ml-6")}>
              {i < steps.length - 1 && <span className={cn("absolute left-[13px] top-7 h-[calc(100%-1.25rem)] w-px", status === "done" ? "bg-primary/60" : "bg-border")} />}
              <span className={cn("relative z-10 grid size-7 shrink-0 place-items-center rounded-full border text-[11px] font-mono transition-all duration-500",
                status === "done" && "border-primary/60 bg-primary/15 text-primary",
                status === "current" && "glow-primary animate-pulse-ring border-primary bg-primary text-primary-foreground",
                status === "pending" && "border-border bg-surface-2 text-muted-foreground")}>
                {status === "done" ? <Check className="size-3.5" /> : i + 1}
              </span>
              <div className={cn("min-w-0 flex-1 pt-0.5 transition-opacity", status === "pending" && "opacity-50")}>
                <p className="text-sm">
                  {st.branch && <span className={cn("mr-1.5 font-mono text-[10px]", st.branch === "no" ? "text-occupied" : "text-free")}>{st.branch.toUpperCase()} →</span>}
                  {st.label}
                </p>
                <p className="font-mono text-[11px] text-muted-foreground">
                  {st.hw}{st.hw && s.stageTimes[st.key] ? " · " : ""}{s.stageTimes[st.key] ? fmtTime(s.stageTimes[st.key]) : ""}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { useParking } from "@/lib/parking/store";
import { TIMING } from "@/lib/parking/types";
import { cn } from "@/lib/utils";
import { DemoControls } from "@/components/dash/DemoControls";
import { GateVisual, LogList, Oled, Panel, Pill, QrPanel } from "@/components/dash/kit";

export const Route = createFileRoute("/entry")({
  head: () => ({
    meta: [
      { title: "Entry Management — ParkSense" },
      { name: "description", content: "HC-SR04 vehicle detection, slot allocation, payment QR and entry barrier status." },
      { property: "og:title", content: "Entry Management — ParkSense" },
      { property: "og:description", content: "HC-SR04 vehicle detection, slot allocation, payment QR and entry barrier status." },
    ],
  }),
  component: Entry,
});

const STAGES = [
  { label: "Monitoring", keys: ["scan"] },
  { label: "Detecting (5×)", keys: ["check_us"] },
  { label: "Slot reserved", keys: ["detected", "allocate", "reserve"] },
  { label: "QR + gate open", keys: ["qr", "gate_open", "passes"] },
  { label: "Clear 1.5 s → close", keys: ["clear", "gate_close"] },
  { label: "Welcome (3 s)", keys: ["welcome"] },
];

function Entry() {
  const { state: s } = useParking();
  const idx = s.entryStage === "full" ? -1 : STAGES.findIndex((st) => st.keys.includes(s.entryStage));
  const detected = s.distanceCm < TIMING.detectCm;
  const pct = Math.min(100, (s.distanceCm / 150) * 100);
  return (
    <div className="space-y-5">
      <DemoControls compact />
      <Panel title="Entry sequence">
        {s.entryStage === "full" ? (
          <p className="rounded-lg bg-occupied/10 p-3 text-sm text-occupied">PARKING FULL — three beeps, barrier stays closed until the vehicle backs away (&gt;20 cm).</p>
        ) : (
          <ol className="grid grid-cols-2 gap-2 md:grid-cols-6">
            {STAGES.map((st, i) => (
              <li key={st.label} className={cn("rounded-lg border p-3 text-xs transition-all duration-500",
                i < idx && "border-primary/40 text-primary", i === idx && "glow-primary border-primary bg-primary/10", i > idx && "border-border text-muted-foreground")}>
                <span className="mb-1 flex items-center gap-1 font-mono">{i < idx ? <Check className="size-3" /> : `0${i + 1}`}</span>{st.label}
              </li>
            ))}
          </ol>
        )}
      </Panel>
      <div className="grid gap-5 lg:grid-cols-3">
        <Panel title="HC-SR04 entry sensor">
          <div className="flex items-end justify-between">
            <p className="font-mono text-4xl font-semibold tabular-nums">{s.usOk ? s.distanceCm.toFixed(1) : "--"}<span className="ml-1 text-base text-muted-foreground">cm</span></p>
            <Pill t={!s.usOk ? "error" : detected ? "reserved" : "free"} pulse={detected}>{!s.usOk ? "No echo" : detected ? "Vehicle" : "Clear"}</Pill>
          </div>
          <div className="relative mt-4 h-2 rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary transition-all duration-150" style={{ width: `${pct}%` }} />
            <span className="absolute top-0 h-2 w-px bg-reserved" style={{ left: `${(15 / 150) * 100}%` }} title="15 cm detect" />
            <span className="absolute top-0 h-2 w-px bg-free" style={{ left: `${(20 / 150) * 100}%` }} title="20 cm clear" />
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-y-1.5 font-mono text-xs">
            <dt className="text-muted-foreground">Poll rate</dt><dd className="text-right">100 ms</dd>
            <dt className="text-muted-foreground">Detect / clear</dt><dd className="text-right">&lt;15 / &gt;20 cm</dd>
            <dt className="text-muted-foreground">Consecutive reads</dt><dd className="text-right">{Math.min(s.detectCount, 5)} / 5</dd>
            <dt className="text-muted-foreground">TRIG / ECHO</dt><dd className="text-right">GPIO 5 / 18</dd>
          </dl>
        </Panel>
        <Panel title="Entry barrier & OLED">
          <GateVisual open={s.entryServo === 90} label="GPIO 13" />
          <div className="mt-4"><Oled lines={s.oled} qr={s.entryPhase === "GATE_OPEN"} /></div>
          <p className="mt-3 text-sm">Assigned slot: <span className="font-mono text-reserved">{s.assignedSlot ?? "—"}</span></p>
        </Panel>
        <Panel title="Payment QR"><QrPanel s={s} /></Panel>
      </div>
      <Panel title="Entry events"><LogList logs={s.logs.filter((l) => l.category === "entry")} limit={15} empty="No vehicles at the entry yet" /></Panel>
    </div>
  );
}

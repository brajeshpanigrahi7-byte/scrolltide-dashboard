import { createFileRoute, Link } from "@tanstack/react-router";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Activity, Car, CheckCircle2, Clock, Cpu, Gauge, ParkingSquare, ShieldCheck } from "lucide-react";
import { useParking } from "@/lib/parking/store";
import { counts, occupancyPct } from "@/lib/parking/engine";
import { ENTRY_STEPS, EXIT_STEPS } from "@/components/dash/Workflow";
import { DemoControls } from "@/components/dash/DemoControls";
import { GateVisual, LogList, Panel, Pill, SlotCard, StatCard, fmtTime } from "@/components/dash/kit";
import { CollectedTotal, SessionPanel } from "@/components/dash/SessionPanel";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Overview — ParkSense Smart Parking" },
      { name: "description", content: "Live KPIs, slot occupancy, gates and sensor health for the ESP32 smart parking system." },
      { property: "og:title", content: "Overview — ParkSense Smart Parking" },
      { property: "og:description", content: "Live KPIs, slot occupancy, gates and sensor health for the ESP32 smart parking system." },
    ],
  }),
  component: Overview,
});

function Overview() {
  const { state: s, mode } = useParking();
  const c = counts(s);
  const sensorsOk = s.slots.filter((x) => x.sensorOk).length + (s.usOk ? 1 : 0);
  const chart = s.history.map((h) => ({ time: fmtTime(h.t), Occupied: h.occupied, Reserved: h.reserved, Free: h.free }));

  return (
    <div className="space-y-5">
      <DemoControls compact />
      {mode === "live" && <><CollectedTotal /><SessionPanel /></>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Total slots" value={5} icon={<ParkingSquare className="size-4" />} sub="IR-monitored bays" />
        <StatCard label="Available" value={c.free} t="free" icon={<CheckCircle2 className="size-4" />} sub="LED green" />
        <StatCard label="Occupied" value={c.occupied} t="occupied" icon={<Car className="size-4" />} sub="LED red" />
        <StatCard label="Reserved" value={c.reserved} t="reserved" icon={<Clock className="size-4" />} sub="60 s hold · LED yellow" />
        <StatCard label="Occupancy" value={`${occupancyPct(s).toFixed(0)}%`} icon={<Gauge className="size-4" />} sub="Occupied ÷ 5 (excl. reserved)" />
        <StatCard label="Vehicles inside" value={c.occupied} t="primary" icon={<Activity className="size-4" />} sub="Parked & detected by IR" />
        <StatCard label="ESP32" value={s.online ? "Online" : "Offline"} t={s.online ? "free" : "error"} icon={<Cpu className="size-4" />} sub="Heartbeat" />
        <StatCard label="System" value={sensorsOk === 6 ? "Normal" : "Degraded"} t={sensorsOk === 6 ? "free" : "warning"} icon={<ShieldCheck className="size-4" />} sub={`${sensorsOk}/6 sensors healthy`} />
      </div>

      {mode === "live" && !s.online && <p className="text-sm text-warning">ESP32 offline — slot and barrier readings are unavailable.</p>}
      {(mode === "demo" || s.online) && <><Panel title="Parking slots" action={<Link to="/parking" className="text-xs text-primary hover:underline">Open live view →</Link>}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">{s.slots.map((x) => <SlotCard key={x.id} slot={x} now={s.now} compact />)}</div>
      </Panel>

      <div className="grid gap-5 lg:grid-cols-3">
        <Panel title="Occupancy (this session)" className="lg:col-span-2">
          <div className="h-60">
            {chart.length < 2 ? <p className="grid h-full place-items-center text-sm text-muted-foreground">Collecting samples every 5 s…</p> : (
              <ResponsiveContainer>
                <AreaChart data={chart}>
                  <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                  <XAxis dataKey="time" tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} minTickGap={40} />
                  <YAxis domain={[0, 5]} allowDecimals={false} tick={{ fill: "var(--muted-foreground)", fontSize: 11 }} width={24} />
                  <Tooltip contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8 }} />
                  <Area type="stepAfter" dataKey="Occupied" stackId="1" stroke="var(--occupied)" fill="var(--occupied)" fillOpacity={0.35} />
                  <Area type="stepAfter" dataKey="Reserved" stackId="1" stroke="var(--reserved)" fill="var(--reserved)" fillOpacity={0.35} />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </Panel>
        <Panel title="Recent activity" action={<Link to="/logs" className="text-xs text-primary hover:underline">All →</Link>}>
          <div className="max-h-60 overflow-y-auto pr-1"><LogList logs={s.logs} limit={8} /></div>
        </Panel>
      </div>

      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
        <Panel title="Entry gate"><GateVisual open={s.entryServo === 90} label="GPIO 13" /><p className="mt-3 font-mono text-xs text-muted-foreground">HC-SR04: {s.usOk ? `${s.distanceCm.toFixed(1)} cm` : "FAULT"}</p></Panel>
        <Panel title="Exit gate"><GateVisual open={s.exitServo === 90} label="GPIO 27" /><p className="mt-3 font-mono text-xs text-muted-foreground">Exit: {s.exitPhase === "OPEN" ? "Barrier open (60 s)" : "Standby"}</p></Panel>
        <Panel title="Sensor health">
          <div className="flex flex-wrap gap-2">
            {s.slots.map((x) => <Pill key={x.id} t={x.sensorOk ? "free" : "error"}>IR{x.id}</Pill>)}
            <Pill t={s.usOk ? "free" : "error"}>HC-SR04</Pill>
          </div>
        </Panel>
        <Panel title="Workflow now">
          <p className="text-sm"><span className="text-muted-foreground">Entry:</span> {ENTRY_STEPS.find((x) => x.key === s.entryStage)?.label}</p>
          <p className="mt-2 text-sm"><span className="text-muted-foreground">Exit:</span> {EXIT_STEPS.find((x) => x.key === s.exitStage)?.label ?? "Idle"}</p>
          <Link to="/workflow" className="mt-3 inline-block text-xs text-primary hover:underline">View diagram →</Link>
        </Panel>
      </div>
      </>}
    </div>
  );
}

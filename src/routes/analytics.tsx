import { createFileRoute } from "@tanstack/react-router";
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useParking } from "@/lib/parking/store";
import { counts, occupancyPct } from "@/lib/parking/engine";
import { Panel, StatCard, fmtTime } from "@/components/dash/kit";
import { LogIn, LogOut, Gauge, AlertTriangle } from "lucide-react";
import { CollectedTotal, SessionPanel } from "@/components/dash/SessionPanel";

export const Route = createFileRoute("/analytics")({
  head: () => ({
    meta: [
      { title: "Analytics & Reports — ParkSense" },
      { name: "description", content: "Occupancy, slot utilisation and entry/exit activity recorded this session." },
      { property: "og:title", content: "Analytics & Reports — ParkSense" },
      { property: "og:description", content: "Occupancy, slot utilisation and entry/exit activity recorded this session." },
    ],
  }),
  component: Analytics,
});

const tip = { contentStyle: { background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 8 } };
const axis = { tick: { fill: "var(--muted-foreground)", fontSize: 11 } };

function Analytics() {
  const { state: s, mode } = useParking();
  if (mode === "live") return <div className="space-y-5"><CollectedTotal /><SessionPanel /></div>;
  const c = counts(s);
  const pie = [
    { name: "Free", value: c.free, color: "var(--free)" },
    { name: "Reserved", value: c.reserved, color: "var(--reserved)" },
    { name: "Occupied", value: c.occupied, color: "var(--occupied)" },
  ];
  const util = s.slots.map((x) => ({
    slot: `S${x.id}`,
    events: s.logs.filter((l) => l.slot === x.id && l.category === "slot").length,
  }));
  // Bucket entry/exit events per minute
  const buckets = new Map<string, { t: string; Entries: number; Exits: number }>();
  [...s.logs].reverse().forEach((l) => {
    const key = new Date(l.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const b = buckets.get(key) ?? { t: key, Entries: 0, Exits: 0 };
    if (l.message.startsWith("Entry barrier opened")) b.Entries++;
    if (l.message.startsWith("Exit barrier opened")) b.Exits++;
    buckets.set(key, b);
  });
  const sensorFreq = [
    { name: "IR changes", v: s.counters.irEvents },
    { name: "US detects", v: s.counters.usDetections },
    { name: "Faults", v: s.logs.filter((l) => l.category === "sensor" && l.severity === "error").length },
  ];
  const occLine = s.history.map((h) => ({ t: fmtTime(h.t), pct: (h.occupied / 5) * 100 }));

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        {mode === "demo" ? "Simulated metrics from this demo session only." : "Metrics recorded since this page was opened."} No historical records are invented.
      </p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Entries" value={s.counters.entries} icon={<LogIn className="size-4" />} t="free" />
        <StatCard label="Exits" value={s.counters.exits} icon={<LogOut className="size-4" />} />
        <StatCard label="Occupancy now" value={`${occupancyPct(s).toFixed(0)}%`} icon={<Gauge className="size-4" />} t="occupied" />
        <StatCard label="Full warnings" value={s.counters.full} icon={<AlertTriangle className="size-4" />} t="warning" />
      </div>
      <div className="grid gap-5 lg:grid-cols-3">
        <Panel title="Free vs reserved vs occupied">
          <div className="h-56"><ResponsiveContainer><PieChart><Pie data={pie} dataKey="value" innerRadius={50} outerRadius={80} paddingAngle={3}>{pie.map((p) => <Cell key={p.name} fill={p.color} stroke="none" />)}</Pie><Tooltip {...tip} /></PieChart></ResponsiveContainer></div>
        </Panel>
        <Panel title="Occupancy % over session" className="lg:col-span-2">
          <div className="h-56"><ResponsiveContainer><LineChart data={occLine}><CartesianGrid stroke="var(--border)" strokeDasharray="3 3" /><XAxis dataKey="t" {...axis} minTickGap={40} /><YAxis domain={[0, 100]} {...axis} width={30} /><Tooltip {...tip} /><Line type="stepAfter" dataKey="pct" stroke="var(--primary)" dot={false} strokeWidth={2} /></LineChart></ResponsiveContainer></div>
        </Panel>
        <Panel title="Slot status changes">
          <div className="h-56"><ResponsiveContainer><BarChart data={util}><CartesianGrid stroke="var(--border)" strokeDasharray="3 3" /><XAxis dataKey="slot" {...axis} /><YAxis allowDecimals={false} {...axis} width={24} /><Tooltip {...tip} cursor={{ fill: "var(--accent)" }} /><Bar dataKey="events" fill="var(--chart-1)" radius={[4, 4, 0, 0]} /></BarChart></ResponsiveContainer></div>
        </Panel>
        <Panel title="Entry & exit events per minute">
          <div className="h-56"><ResponsiveContainer><BarChart data={[...buckets.values()].filter((b) => b.Entries || b.Exits)}><CartesianGrid stroke="var(--border)" strokeDasharray="3 3" /><XAxis dataKey="t" {...axis} /><YAxis allowDecimals={false} {...axis} width={24} /><Tooltip {...tip} cursor={{ fill: "var(--accent)" }} /><Bar dataKey="Entries" fill="var(--free)" radius={[4, 4, 0, 0]} /><Bar dataKey="Exits" fill="var(--primary)" radius={[4, 4, 0, 0]} /></BarChart></ResponsiveContainer></div>
        </Panel>
        <Panel title="Sensor event frequency">
          <div className="h-56"><ResponsiveContainer><BarChart data={sensorFreq} layout="vertical"><XAxis type="number" allowDecimals={false} {...axis} /><YAxis type="category" dataKey="name" {...axis} width={80} /><Tooltip {...tip} cursor={{ fill: "var(--accent)" }} /><Bar dataKey="v" fill="var(--chart-5)" radius={[0, 4, 4, 0]} /></BarChart></ResponsiveContainer></div>
        </Panel>
      </div>
    </div>
  );
}

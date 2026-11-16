import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import {
  Radar,
  Waves,
  Wifi,
  Clock,
  Activity,
  Gauge,
  Cpu,
  ArrowRight,
} from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { useParking } from "@/lib/parking/store";
import { GPIO, TIMING } from "@/lib/parking/types";
import { Button } from "@/components/ui/button";
import { Panel, Pill, ago, fmtTime } from "@/components/dash/kit";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/sensors")({
  head: () => ({
    meta: [
      { title: "Sensor Monitoring — ParkSense" },
      { name: "description", content: "Live ultrasonic distance gauge, 60-reading chart, 5 IR sensors, Wi-Fi RSSI, and hardware health." },
    ],
  }),
  component: Sensors,
});

const ENTRY_STATES = [
  "0 - Idle",
  "1 - Waiting for payment",
  "2 - Gate open",
  "3 - Full",
  "4 - Offline",
];

function Sensors() {
  const { state: s, mode, actions } = useParking();
  const [telemetryHistory, setTelemetryHistory] = useState<any[]>([]);

  // Fetch last 60 telemetry readings for the chart
  useEffect(() => {
    async function fetchTelemetry() {
      const { data } = await supabase
        .from("device_telemetry")
        .select("ts, dist_cm, rssi")
        .order("ts", { ascending: false })
        .limit(60);

      if (data && data.length > 0) {
        const sorted = data.reverse().map((d, i) => {
          const date = new Date(d.ts);
          return {
            time: `${date.getMinutes().toString().padStart(2, "0")}:${date.getSeconds().toString().padStart(2, "0")}`,
            dist: d.dist_cm != null ? Number(d.dist_cm) : 0,
            rssi: d.rssi != null ? Number(d.rssi) : -70,
          };
        });
        setTelemetryHistory(sorted);
      }
    }

    fetchTelemetry();
    const interval = setInterval(fetchTelemetry, 3000);
    return () => clearInterval(interval);
  }, []);

  const heartbeatAgeS = s.lastSeenMs ? Math.max(0, Math.floor((s.now - s.lastSeenMs) / 1000)) : null;

  return (
    <div className="space-y-5">
      {/* ESP32 Hardware Health Bar */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Panel title="Wi-Fi Signal (RSSI)">
          <div className="flex items-center gap-3">
            <div className="size-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary">
              <Wifi className="size-5" />
            </div>
            <div>
              <p className="font-mono text-2xl font-bold">{s.rssi != null ? `${s.rssi} dBm` : "—"}</p>
              <p className="text-xs text-muted-foreground">
                {s.rssi != null && s.rssi > -67 ? "Excellent Signal" : s.rssi != null && s.rssi > -80 ? "Good Signal" : "Weak"}
              </p>
            </div>
          </div>
        </Panel>

        <Panel title="System Uptime">
          <div className="flex items-center gap-3">
            <div className="size-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary">
              <Clock className="size-5" />
            </div>
            <div>
              <p className="font-mono text-2xl font-bold">
                {s.uptime_s != null ? `${Math.floor(s.uptime_s / 60)}m ${s.uptime_s % 60}s` : "—"}
              </p>
              <p className="text-xs text-muted-foreground">Continuous Operation</p>
            </div>
          </div>
        </Panel>

        <Panel title="Heartbeat Age">
          <div className="flex items-center gap-3">
            <div className="size-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary">
              <Activity className="size-5" />
            </div>
            <div>
              <p className="font-mono text-2xl font-bold">
                {heartbeatAgeS != null ? `${heartbeatAgeS}s ago` : "—"}
              </p>
              <p className="text-xs text-muted-foreground">
                {s.online ? "Heartbeat Active" : "Heartbeat Timeout"}
              </p>
            </div>
          </div>
        </Panel>

        <Panel title="Entry State">
          <div className="flex items-center gap-3">
            <div className="size-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary">
              <Cpu className="size-5" />
            </div>
            <div>
              <p className="font-mono text-lg font-bold truncate">
                {ENTRY_STATES[s.entryStateNum ?? 0] ?? `State ${s.entryStateNum}`}
              </p>
              <p className="text-xs text-muted-foreground">ESP32 State Machine</p>
            </div>
          </div>
        </Panel>
      </div>

      {/* Ultrasonic Distance Gauge & 60-Reading Chart */}
      <div className="grid gap-5 lg:grid-cols-3">
        <Panel title="HC-SR04 Distance Gauge">
          <div className="flex flex-col items-center justify-center py-6 space-y-4">
            <div className="relative flex items-center justify-center">
              <div className="size-36 rounded-full border-4 border-dashed border-border flex flex-col items-center justify-center">
                <span className="font-mono text-4xl font-extrabold text-primary">
                  {s.distanceCm ? s.distanceCm.toFixed(1) : "—"}
                </span>
                <span className="text-xs text-muted-foreground font-mono">cm</span>
              </div>
            </div>
            <div className="text-center space-y-1">
              <p className="text-sm font-semibold">
                {s.distanceCm < 15 ? (
                  <span className="text-rose-400">Vehicle Detected (&lt;15 cm)</span>
                ) : s.distanceCm <= 20 ? (
                  <span className="text-amber-400">Detection Zone (15-20 cm)</span>
                ) : (
                  <span className="text-emerald-400">Clear Lane (&gt;20 cm)</span>
                )}
              </p>
              <p className="text-xs text-muted-foreground font-mono">
                TRIG: GPIO 5 · ECHO: GPIO 18 · Thresholds: 15 cm / 20 cm
              </p>
            </div>
          </div>
        </Panel>

        <Panel title="Ultrasonic Distance (Last 60 Readings)" className="lg:col-span-2">
          <div className="h-64">
            {telemetryHistory.length < 2 ? (
              <p className="grid h-full place-items-center text-sm text-muted-foreground">
                Collecting sensor telemetry samples from ESP32…
              </p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={telemetryHistory}>
                  <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                  <XAxis dataKey="time" tick={{ fill: "var(--muted-foreground)", fontSize: 10 }} />
                  <YAxis
                    domain={[0, 150]}
                    tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
                    unit="cm"
                    width={45}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "var(--popover)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                    }}
                  />
                  {/* Threshold Lines */}
                  <ReferenceLine
                    y={15}
                    stroke="#f43f5e"
                    strokeDasharray="4 4"
                    label={{ value: "Detect (<15cm)", fill: "#f43f5e", fontSize: 10, position: "insideBottomLeft" }}
                  />
                  <ReferenceLine
                    y={20}
                    stroke="#10b981"
                    strokeDasharray="4 4"
                    label={{ value: "Clear (>20cm)", fill: "#10b981", fontSize: 10, position: "insideTopLeft" }}
                  />
                  <Line
                    type="monotone"
                    dataKey="dist"
                    name="Distance (cm)"
                    stroke="var(--primary)"
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </Panel>
      </div>

      {/* 5 IR Sensor Indicators */}
      <Panel title="5 IR Slot Proximity Sensors">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {s.slots.map((x) => {
            const debouncing = x.irPendingSince !== null && x.sensorOk;
            const prog = debouncing ? Math.min(100, ((s.now - x.irPendingSince!) / TIMING.irDebounceMs) * 100) : 0;
            const lastEvt = s.logs.find((l) => l.slot === x.id && l.category === "slot");

            return (
              <div
                key={x.id}
                className="rounded-xl border border-border bg-surface-2 p-4 flex flex-col justify-between space-y-3"
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-sm">Slot {x.id} IR</span>
                  <Pill t={x.sensorOk ? (x.irRaw ? "occupied" : "free") : "error"}>
                    {x.sensorOk ? (x.irRaw ? "BEAM BLOCKED" : "BEAM CLEAR") : "FAULT"}
                  </Pill>
                </div>
                <dl className="grid grid-cols-2 gap-y-1.5 text-xs font-mono">
                  <dt className="text-muted-foreground">GPIO</dt>
                  <dd className="text-right text-foreground">{GPIO.ir[x.id - 1]}</dd>
                  <dt className="text-muted-foreground">State</dt>
                  <dd className={`text-right font-bold ${x.irRaw ? "text-rose-400" : "text-emerald-400"}`}>
                    {x.irRaw ? "DETECT" : "CLEAR"}
                  </dd>
                  <dt className="text-muted-foreground">Debounce</dt>
                  <dd className="text-right">{debouncing ? `${prog.toFixed(0)}%` : "Stable"}</dd>
                </dl>
                <div className="h-1 overflow-hidden rounded-full bg-muted">
                  <div className="h-full bg-primary transition-all" style={{ width: `${prog}%` }} />
                </div>
                {mode === "demo" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="w-full text-xs"
                    onClick={() => actions.toggleSensor(x.id)}
                  >
                    {x.sensorOk ? "Simulate fault" : "Restore"}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      </Panel>
    </div>
  );
}

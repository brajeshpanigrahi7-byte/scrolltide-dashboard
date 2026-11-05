import { createFileRoute } from "@tanstack/react-router";
import { Radar, Waves } from "lucide-react";
import { useParking } from "@/lib/parking/store";
import { GPIO, TIMING } from "@/lib/parking/types";
import { Button } from "@/components/ui/button";
import { Panel, Pill, ago, fmtTime } from "@/components/dash/kit";

export const Route = createFileRoute("/sensors")({
  head: () => ({
    meta: [
      { title: "Sensor Monitoring — ParkSense" },
      { name: "description", content: "Health, debounce and readings for five IR sensors and the HC-SR04 entry sensor." },
      { property: "og:title", content: "Sensor Monitoring — ParkSense" },
      { property: "og:description", content: "Health, debounce and readings for five IR sensors and the HC-SR04 entry sensor." },
    ],
  }),
  component: Sensors,
});

function Sensors() {
  const { state: s, mode, actions } = useParking();
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {s.slots.map((x) => {
        const debouncing = x.irPendingSince !== null && x.sensorOk;
        const prog = debouncing ? Math.min(100, ((s.now - x.irPendingSince!) / TIMING.irDebounceMs) * 100) : 0;
        const lastEvt = s.logs.find((l) => l.slot === x.id && l.category === "slot");
        return (
          <Panel key={x.id} title={`IR sensor ${x.id}`} icon={<Radar className="size-4" />} action={<Pill t={x.sensorOk ? "free" : "error"}>{x.sensorOk ? "OK" : "Fault"}</Pill>}>
            <dl className="grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-muted-foreground">GPIO</dt><dd className="text-right font-mono">{GPIO.ir[x.id - 1]} (input-only)</dd>
              <dt className="text-muted-foreground">Detection</dt><dd className="text-right">{x.irRaw ? "Vehicle" : "Clear"}</dd>
              <dt className="text-muted-foreground">Debounce (2 s)</dt><dd className="text-right font-mono">{debouncing ? `${prog.toFixed(0)}%` : "Stable"}</dd>
              <dt className="text-muted-foreground">Last event</dt><dd className="truncate text-right text-xs">{lastEvt ? ago(lastEvt.ts, s.now) : "—"}</dd>
              <dt className="text-muted-foreground">Updated</dt><dd className="text-right font-mono">{fmtTime(x.lastUpdate)}</dd>
            </dl>
            <div className="mt-3 h-1 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary transition-all" style={{ width: `${prog}%` }} /></div>
            {mode === "demo" && <Button size="sm" variant="ghost" className="mt-3" onClick={() => actions.toggleSensor(x.id)}>{x.sensorOk ? "Simulate fault" : "Restore"}</Button>}
          </Panel>
        );
      })}
      <Panel title="HC-SR04 entry" icon={<Waves className="size-4" />} action={<Pill t={s.usOk ? "free" : "error"}>{s.usOk ? "OK" : "No echo"}</Pill>}>
        <dl className="grid grid-cols-2 gap-y-2 text-sm">
          <dt className="text-muted-foreground">TRIG / ECHO</dt><dd className="text-right font-mono">5 / 18</dd>
          <dt className="text-muted-foreground">Distance</dt><dd className="text-right font-mono">{s.usOk ? `${s.distanceCm.toFixed(1)} cm` : "—"}</dd>
          <dt className="text-muted-foreground">Detection</dt><dd className="text-right">{s.distanceCm < TIMING.detectCm ? "Vehicle" : "Clear"}</dd>
          <dt className="text-muted-foreground">Debounce</dt><dd className="text-right font-mono">{Math.min(s.detectCount, 5)}/5 reads</dd>
          <dt className="text-muted-foreground">Detections</dt><dd className="text-right font-mono">{s.counters.usDetections}</dd>
        </dl>
        {mode === "demo" && <Button size="sm" variant="ghost" className="mt-3" onClick={() => actions.toggleSensor("us")}>{s.usOk ? "Simulate fault" : "Restore"}</Button>}
      </Panel>
    </div>
  );
}

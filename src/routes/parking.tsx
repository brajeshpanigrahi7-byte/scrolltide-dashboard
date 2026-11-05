import { createFileRoute } from "@tanstack/react-router";
import { useParking } from "@/lib/parking/store";
import { DemoControls } from "@/components/dash/DemoControls";
import { Legend, Panel, SlotCard } from "@/components/dash/kit";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/parking")({
  head: () => ({
    meta: [
      { title: "Live Parking — ParkSense" },
      { name: "description", content: "Five parking bays with IR sensor state, RGB LED colour and reservation countdown." },
      { property: "og:title", content: "Live Parking — ParkSense" },
      { property: "og:description", content: "Five parking bays with IR sensor state, RGB LED colour and reservation countdown." },
    ],
  }),
  component: LiveParking,
});

function LiveParking() {
  const { state: s, mode, actions } = useParking();
  return (
    <div className="space-y-5">
      <DemoControls />
      <Panel title="Parking layout" action={<Legend />}>
        <div className="rounded-xl bg-background/60 p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:grid-cols-5">{s.slots.map((x) => <SlotCard key={x.id} slot={x} now={s.now} />)}</div>
          <div className="mt-4 flex items-center justify-between rounded-lg border border-dashed border-border px-4 py-3 font-mono text-xs text-muted-foreground">
            <span>← ENTRY (HC-SR04 + servo 13)</span><span className="hidden sm:inline">DRIVE LANE</span><span>EXIT (BOOT + servo 27) →</span>
          </div>
        </div>
      </Panel>
      {mode === "demo" && (
        <Panel title="Simulate IR sensors">
          <p className="mb-3 text-sm text-muted-foreground">Toggle a vehicle in front of each IR sensor. The slot changes only after the reading is stable for 2 seconds, like the firmware.</p>
          <div className="flex flex-wrap gap-2">
            {s.slots.map((x) => (
              <Button key={x.id} size="sm" variant={x.irRaw ? "destructive" : "secondary"} onClick={() => actions.setIr(x.id, !x.irRaw)}>
                IR {x.id}: {x.irRaw ? "vehicle" : "empty"}
              </Button>
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}

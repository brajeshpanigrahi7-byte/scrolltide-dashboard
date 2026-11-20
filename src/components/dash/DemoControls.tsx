import { Car, CarFront, DoorOpen, FlaskConical, Radio, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useParking } from "@/lib/parking/store";

export function DemoControls({ compact }: { compact?: boolean }) {
  const { mode, setDemoMode, actions, autoDemo, setAutoDemo, state } = useParking();

  if (mode !== "demo") {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 bg-muted/20 px-3.5 py-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <Radio className="size-3.5 text-primary" />
          <span>
            Live Hardware Mode · Listening for ESP32 (
            <code className="font-mono text-foreground">esp32-entry-1</code>)
          </span>
          {!state.online && <span className="font-medium text-warning">· Device offline</span>}
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={() => setDemoMode(true)}
        >
          <FlaskConical className="mr-1.5 size-3.5 text-warning" />
          Activate Demo Simulator
        </Button>
      </div>
    );
  }

  return (
    <div className="panel flex flex-wrap items-center gap-2 border-warning/30 p-3">
      <span className="mr-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-warning">
        <FlaskConical className="size-4" />
        Demo simulator
      </span>
      <Button size="sm" variant="secondary" onClick={actions.vehicleArrives}>
        <CarFront className="size-4" />
        Vehicle at entry
      </Button>
      <Button size="sm" variant="secondary" onClick={actions.parkAssigned}>
        <Car className="size-4" />
        Vehicle parks
      </Button>
      <Button size="sm" variant="secondary" onClick={actions.triggerExit}>
        <DoorOpen className="size-4" />
        Session ends & exit (60 s)
      </Button>
      {!compact && (
        <Button size="sm" variant="secondary" onClick={() => actions.leaveSlot()}>
          Vehicle leaves
        </Button>
      )}
      {!compact && (
        <Button size="sm" variant="ghost" onClick={actions.reset}>
          <RotateCcw className="size-4" />
          Reset
        </Button>
      )}
      <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
        Auto-play <Switch checked={autoDemo} onCheckedChange={setAutoDemo} />
      </label>
    </div>
  );
}

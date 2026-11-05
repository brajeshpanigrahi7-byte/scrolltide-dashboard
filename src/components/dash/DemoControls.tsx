import { Car, CarFront, FlaskConical, MousePointerClick, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useParking } from "@/lib/parking/store";

export function DemoControls({ compact }: { compact?: boolean }) {
  const { mode, actions, autoDemo, setAutoDemo } = useParking();
  if (mode !== "demo") return null;
  return (
    <div className="panel flex flex-wrap items-center gap-2 border-warning/30 p-3">
      <span className="mr-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-warning"><FlaskConical className="size-4" />Demo simulator</span>
      <Button size="sm" variant="secondary" onClick={actions.vehicleArrives}><CarFront className="size-4" />Vehicle at entry</Button>
      <Button size="sm" variant="secondary" onClick={actions.parkAssigned}><Car className="size-4" />Vehicle parks</Button>
      <Button size="sm" variant="secondary" onClick={actions.pressBoot}><MousePointerClick className="size-4" />Press BOOT</Button>
      {!compact && <Button size="sm" variant="secondary" onClick={() => actions.leaveSlot()}>Vehicle leaves</Button>}
      {!compact && <Button size="sm" variant="ghost" onClick={actions.reset}><RotateCcw className="size-4" />Reset</Button>}
      <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">Auto-play <Switch checked={autoDemo} onCheckedChange={setAutoDemo} /></label>
    </div>
  );
}

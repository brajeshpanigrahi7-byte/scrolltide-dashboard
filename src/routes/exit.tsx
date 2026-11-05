import { createFileRoute } from "@tanstack/react-router";
import { MousePointerClick } from "lucide-react";
import { useParking } from "@/lib/parking/store";
import { TIMING } from "@/lib/parking/types";
import { Button } from "@/components/ui/button";
import { GateVisual, LogList, Oled, Panel, Pill, fmtTime } from "@/components/dash/kit";

export const Route = createFileRoute("/exit")({
  head: () => ({
    meta: [
      { title: "Exit Management — ParkSense" },
      { name: "description", content: "BOOT-button payment confirmation and 5-second exit barrier cycle." },
      { property: "og:title", content: "Exit Management — ParkSense" },
      { property: "og:description", content: "BOOT-button payment confirmation and 5-second exit barrier cycle." },
    ],
  }),
  component: Exit,
});

function Exit() {
  const { state: s, mode, actions } = useParking();
  const remain = s.exitCloseAt ? Math.max(0, (s.exitCloseAt - s.now) / 1000) : 0;
  const open = s.exitPhase === "OPEN";
  return (
    <div className="space-y-5">
      <p className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
        There is no exit sensor. The exit is triggered only by holding the ESP32 BOOT button (GPIO 0) for ~200 ms, which simulates payment confirmation.
      </p>
      <div className="grid gap-5 lg:grid-cols-3">
        <Panel title="Exit barrier">
          <GateVisual open={open} label="GPIO 27" />
          <div className="mt-5">
            <div className="flex justify-between font-mono text-xs text-muted-foreground"><span>Closes in</span><span>{open ? `${remain.toFixed(1)} s` : "—"}</span></div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted"><div className="h-full bg-free transition-all duration-100" style={{ width: `${(remain / (TIMING.exitOpenMs / 1000)) * 100}%` }} /></div>
          </div>
        </Panel>
        <Panel title="Payment confirmation">
          <dl className="grid grid-cols-2 gap-y-3 text-sm">
            <dt className="text-muted-foreground">Status</dt><dd>{open ? <Pill t="free" pulse>Payment OK</Pill> : s.paymentAt ? <Pill t="free">Last: OK</Pill> : <Pill t="muted">Waiting</Pill>}</dd>
            <dt className="text-muted-foreground">BOOT event</dt><dd className="font-mono">{fmtTime(s.bootPressedAt)}</dd>
            <dt className="text-muted-foreground">Method</dt><dd>Simulated (BOOT)</dd>
            <dt className="text-muted-foreground">Buzzer</dt><dd>{s.now < s.buzzerUntil ? <Pill t="warning" pulse>Beep</Pill> : <Pill t="muted">Silent</Pill>}</dd>
          </dl>
          {mode === "demo" && <Button className="mt-5 w-full" onClick={actions.pressBoot} disabled={open}><MousePointerClick className="size-4" />Press BOOT (simulate)</Button>}
        </Panel>
        <Panel title="OLED"><Oled lines={s.oled} qr={s.entryPhase === "GATE_OPEN"} /><p className="mt-3 text-xs text-muted-foreground">Shows PAYMENT OK / THANK YOU during the exit cycle.</p></Panel>
      </div>
      <Panel title="Exit events"><LogList logs={s.logs.filter((l) => l.category === "exit")} limit={15} empty="No exits yet — press BOOT to simulate one" /></Panel>
    </div>
  );
}

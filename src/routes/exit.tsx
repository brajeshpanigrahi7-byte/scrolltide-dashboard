import { createFileRoute } from "@tanstack/react-router";
import { DoorOpen } from "lucide-react";
import { useParking } from "@/lib/parking/store";
import { TIMING } from "@/lib/parking/types";
import { Button } from "@/components/ui/button";
import { GateVisual, LogList, Oled, Panel, Pill, fmtTime } from "@/components/dash/kit";

export const Route = createFileRoute("/exit")({
  head: () => ({
    meta: [
      { title: "Exit Management — ParkSense" },
      { name: "description", content: "Session expiry and 60-second exit barrier cycle." },
      { property: "og:title", content: "Exit Management — ParkSense" },
      { property: "og:description", content: "Session expiry and 60-second exit barrier cycle." },
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
      <div className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm text-foreground">
        Exit is automatically authorized when a session expires. The dashboard signals the ESP32 via{" "}
        <code className="text-xs font-mono text-primary">/api/public/device-due</code>, opening the exit barrier for 60 seconds.
      </div>
      <div className="grid gap-5 lg:grid-cols-3">
        <Panel title="Exit barrier">
          <GateVisual open={open} label="GPIO 27" />
          <div className="mt-5">
            <div className="flex justify-between font-mono text-xs text-muted-foreground">
              <span>Closes in</span>
              <span>{open ? `${remain.toFixed(1)} s` : "—"}</span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-free transition-all duration-100"
                style={{ width: `${(remain / (TIMING.exitOpenMs / 1000)) * 100}%` }}
              />
            </div>
          </div>
        </Panel>
        <Panel title="Exit authorization">
          <dl className="grid grid-cols-2 gap-y-3 text-sm">
            <dt className="text-muted-foreground">Status</dt>
            <dd>
              {open ? (
                <Pill t="free" pulse>
                  Exit Open (60 s)
                </Pill>
              ) : s.exitSignalledAt ? (
                <Pill t="free">Last: Signalled</Pill>
              ) : (
                <Pill t="muted">Standby</Pill>
              )}
            </dd>
            <dt className="text-muted-foreground">Signal event</dt>
            <dd className="font-mono">{fmtTime(s.exitSignalledAt)}</dd>
            <dt className="text-muted-foreground">Trigger</dt>
            <dd>Session Expiry</dd>
            <dt className="text-muted-foreground">Buzzer</dt>
            <dd>
              {s.now < s.buzzerUntil ? (
                <Pill t="warning" pulse>
                  Beep
                </Pill>
              ) : (
                <Pill t="muted">Silent</Pill>
              )}
            </dd>
          </dl>
          {mode === "demo" && (
            <Button className="mt-5 w-full" onClick={actions.triggerExit} disabled={open}>
              <DoorOpen className="size-4" />
              Simulate session expiry & exit
            </Button>
          )}
        </Panel>
        <Panel title="OLED">
          <Oled lines={s.oled} qr={s.entryPhase === "GATE_OPEN"} />
          <p className="mt-3 text-xs text-muted-foreground">
            Displays SESSION OVER / GATE OPEN 60S during the 60-second exit cycle.
          </p>
        </Panel>
      </div>
      <Panel title="Exit events">
        <LogList
          logs={s.logs.filter((l) => l.category === "exit")}
          limit={15}
          empty="No exits yet — triggered when parking session expires"
        />
      </Panel>
    </div>
  );
}

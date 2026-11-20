import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { DoorOpen, Clock, Car, RefreshCw, AlertCircle } from "lucide-react";
import { useParking } from "@/lib/parking/store";
import { TIMING } from "@/lib/parking/types";
import { Button } from "@/components/ui/button";
import { GateVisual, LogList, Oled, Panel, Pill, fmtTime } from "@/components/dash/kit";
import { supabase } from "@/integrations/supabase/client";
import { openExitGate } from "@/lib/parking/admin.functions";
import { useAuth } from "@/lib/auth-context";

export const Route = createFileRoute("/exit")({
  head: () => ({
    meta: [
      { title: "Exit Management — ParkSense" },
      {
        name: "description",
        content: "Session expiry, active parking sessions and 60-second exit barrier control.",
      },
    ],
  }),
  component: Exit,
});

export function Exit() {
  const { state: s, mode, actions } = useParking();
  const { user, openSignInModal } = useAuth();
  const [openingGate, setOpeningGate] = useState(false);
  const [gateMsg, setGateMsg] = useState<string | null>(null);

  const isExitGateOpen = s.exitOpen || s.exitPhase === "OPEN";
  const remain = s.exitCloseAt ? Math.max(0, (s.exitCloseAt - s.now) / 1000) : 0;

  const handleOpenExitGateNow = async () => {
    if (mode === "live" && !user) {
      openSignInModal();
      setGateMsg("Admin sign-in required to open exit gate in live mode.");
      return;
    }

    setOpeningGate(true);
    setGateMsg(null);
    try {
      if (mode === "demo") {
        actions.triggerExit();
        setGateMsg("Simulated exit gate opened for 60 seconds.");
      } else {
        // Attempt direct Supabase insert
        const { error } = await supabase.from("device_commands").insert({
          device_id: "esp32-entry-1",
          command: "open_exit",
        });

        if (error) {
          // If direct insert encounters RLS policy violation, fallback to server action
          console.warn(
            "Direct insert to device_commands failed, using openExitGate fallback:",
            error,
          );
          try {
            const serverRes = await openExitGate({ data: { device_id: "esp32-entry-1" } });
            if (!serverRes?.ok) {
              throw error;
            }
          } catch {
            throw error;
          }
        }
        setGateMsg("Command sent! ESP32 will open exit barrier on next poll (within 5 s).");
      }
      setTimeout(() => setGateMsg(null), 5000);
    } catch (err: any) {
      setGateMsg(`Error: ${err.message || "Failed to send open command"}`);
    } finally {
      setOpeningGate(false);
    }
  };

  const formatCountdown = (totalSec: number | null | undefined) => {
    if (totalSec == null) return "—";
    const sec = Math.max(0, totalSec);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const activeSessions = (s.activeSessions || []).map((sess: any) => {
    const endMs = sess.end_time ? Date.parse(sess.end_time) : 0;
    const secRemaining = Math.max(0, Math.floor((endMs - s.now) / 1000));
    return {
      ...sess,
      secRemaining,
      isUnderTenMin: secRemaining <= 600 && secRemaining > 0,
    };
  });

  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm text-foreground flex items-center justify-between flex-wrap gap-2">
        <div>
          Exit is automatically authorized when a session expires. The backend signals the ESP32 via{" "}
          <code className="text-xs font-mono text-primary">/device-due</code>, opening the exit
          barrier for 60 seconds.
        </div>
        <Button
          onClick={handleOpenExitGateNow}
          disabled={openingGate || isExitGateOpen}
          variant="outline"
          className="border-primary/50 text-primary hover:bg-primary/20 text-xs font-semibold flex items-center gap-1.5"
        >
          {openingGate ? (
            <RefreshCw className="size-3.5 animate-spin" />
          ) : (
            <DoorOpen className="size-3.5" />
          )}
          Open Exit Gate Now (Admin)
        </Button>
      </div>

      {gateMsg && (
        <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-xs font-medium">
          {gateMsg}
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        {/* Exit barrier visual */}
        <Panel title="Exit barrier">
          <GateVisual open={isExitGateOpen} label="GPIO 27" />
          <div className="mt-5">
            <div className="flex justify-between font-mono text-xs text-muted-foreground">
              <span>Exit Gate State</span>
              <span className={isExitGateOpen ? "text-free font-bold" : "text-muted-foreground"}>
                {isExitGateOpen ? "BARRIER OPEN (60 s)" : "STANDBY / CLOSED"}
              </span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-free transition-all duration-300"
                style={{
                  width: isExitGateOpen
                    ? `${(remain / (TIMING.exitOpenMs / 1000)) * 100 || 100}%`
                    : "0%",
                }}
              />
            </div>
          </div>
        </Panel>

        {/* Exit authorization status */}
        <Panel title="Exit authorization">
          <dl className="grid grid-cols-2 gap-y-3 text-sm">
            <dt className="text-muted-foreground">Gate Status</dt>
            <dd>
              {isExitGateOpen ? (
                <Pill t="free" pulse>
                  Exit Open (60 s)
                </Pill>
              ) : s.exitSignalledAt ? (
                <Pill t="free">Last: Signalled</Pill>
              ) : (
                <Pill t="muted">Standby</Pill>
              )}
            </dd>
            <dt className="text-muted-foreground">Last Signal</dt>
            <dd className="font-mono">{fmtTime(s.exitSignalledAt)}</dd>
            <dt className="text-muted-foreground">Auto Trigger</dt>
            <dd>Session Expiry / Time Over</dd>
            <dt className="text-muted-foreground">Manual Override</dt>
            <dd>device_commands (open_exit)</dd>
          </dl>
          <div className="mt-4 pt-3 border-t border-border">
            <Button
              className="w-full text-xs font-medium"
              onClick={handleOpenExitGateNow}
              disabled={openingGate || isExitGateOpen}
            >
              <DoorOpen className="size-4 mr-1.5" />
              Open Exit Gate Now
            </Button>
          </div>
        </Panel>

        {/* OLED */}
        <Panel title="OLED Display">
          <Oled lines={s.oled} qr={s.entryPhase === "GATE_OPEN"} />
          <p className="mt-3 text-xs text-muted-foreground">
            Shows SESSION OVER / EXIT OPEN during the automated 60-second vehicle clearance cycle.
          </p>
        </Panel>
      </div>

      {/* Active Sessions & Expirations */}
      <Panel title="Active Parking Sessions (Vehicles Inside)">
        {activeSessions.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No active parked vehicles at the moment.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {activeSessions.map((sess: any) => (
              <div
                key={sess.id}
                className={`p-4 rounded-xl border ${
                  sess.isUnderTenMin
                    ? "bg-amber-500/10 border-amber-500/40"
                    : "bg-surface-2 border-border"
                } space-y-2`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono font-bold text-sm text-slate-100 flex items-center gap-1.5">
                    <Car className="size-4 text-primary" /> Slot {sess.slot}
                  </span>
                  <span className="px-2 py-0.5 rounded bg-background font-mono text-xs font-semibold">
                    {sess.code}
                  </span>
                </div>
                <div className="flex items-baseline justify-between pt-1">
                  <span className="text-xs text-muted-foreground">Time Remaining:</span>
                  <span
                    className={`font-mono text-lg font-black ${
                      sess.isUnderTenMin ? "text-amber-400 animate-pulse" : "text-emerald-400"
                    }`}
                  >
                    {formatCountdown(sess.secRemaining)}
                  </span>
                </div>
                {sess.vehicle_no && (
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Vehicle:</span>
                    <span className="font-mono text-slate-300 uppercase">{sess.vehicle_no}</span>
                  </div>
                )}
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Duration:</span>
                  <span>{sess.duration_min} min</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      {/* Exit Events Log */}
      <Panel title="Exit Activity Logs">
        <LogList
          logs={s.logs.filter((l) => l.category === "exit")}
          limit={15}
          empty="No exits yet — triggered when parking session expires"
        />
      </Panel>
    </div>
  );
}

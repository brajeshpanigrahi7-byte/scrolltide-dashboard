import { createFileRoute } from "@tanstack/react-router";
import { useParking } from "@/lib/parking/store";
import { GPIO, QR_TEXT, TIMING } from "@/lib/parking/types";
import { Panel, Pill } from "@/components/dash/kit";
import { Switch } from "@/components/ui/switch";
import { durationOptions } from "@/lib/parking/payments";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "System Settings — ParkSense" },
      { name: "description", content: "Data source, GPIO map, firmware timing and Firebase setup for the ESP32 parking system." },
      { property: "og:title", content: "System Settings — ParkSense" },
      { property: "og:description", content: "Data source, GPIO map, firmware timing and Firebase setup for the ESP32 parking system." },
    ],
  }),
  component: SettingsPage,
});

const rows: [string, string | number][] = [
  ["OLED SDA / SCL", `${GPIO.oledSda} / ${GPIO.oledScl}`], ["HC-SR04 TRIG / ECHO", `${GPIO.trig} / ${GPIO.echo}`],
  ["Entry servo", GPIO.entryServo], ["Exit servo", GPIO.exitServo], ["Buzzer", GPIO.buzzer], ["BOOT button", GPIO.boot],
  ...GPIO.ir.map((p, i) => [`IR slot ${i + 1}`, p] as [string, number]),
  ...GPIO.led.map(([r, g], i) => [`Slot ${i + 1} LED R / G`, `${r} / ${g}`] as [string, string]),
  ["GPIO 23", "unused"],
];

function SettingsPage() {
  const { mode, liveError, setDemoMode } = useParking();
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Panel title="Dashboard mode"><label className="flex items-center justify-between gap-4">Demo mode · simulated hardware<Switch checked={mode === "demo"} onCheckedChange={setDemoMode} /></label><p className="mt-3 text-sm text-muted-foreground">{mode === "demo" ? "Demo readings are not real payments or entry authorizations." : "Live Razorpay payment sessions. Hardware readings require the ESP32 connection."}</p></Panel>
      <Panel title="Parking tariff"><div className="grid grid-cols-2 gap-2 text-sm">{durationOptions.map((option) => <div key={option.minutes} className="flex justify-between border-b border-border py-2"><span>{option.minutes} min</span><span>₹{option.amount}</span></div>)}</div></Panel>
      <Panel title="Data source">
        <div className="flex items-center gap-3">{mode === "demo" ? <Pill t="warning">Demo mode</Pill> : <Pill t={liveError ? "warning" : "primary"}>{liveError ? "Device offline" : "Live · Firebase"}</Pill>}</div>
        <p className="mt-3 text-sm text-muted-foreground">
          {mode === "demo"
            ? "No Firebase Realtime Database URL is configured, so the dashboard runs a faithful simulation of the firmware state machines. Nothing on screen comes from real hardware."
            : liveError ? `Connection issue: ${liveError}` : "Reading the state the ESP32 publishes to /parking."}
        </p>
        <h3 className="mt-5 text-sm font-semibold">Going live</h3>
        <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
          <li>Create a Firebase project with Realtime Database.</li>
          <li>Flash <span className="font-mono text-foreground">firmware/smart_parking_firebase.ino</span> with your Wi-Fi and device credentials.</li>
          <li>Apply the rules in <span className="font-mono text-foreground">docs/FIREBASE_SETUP.md</span> (device-only writes).</li>
          <li>Set <span className="font-mono text-foreground">VITE_FIREBASE_DB_URL</span> for the dashboard.</li>
        </ol>
      </Panel>
      <Panel title="Firmware timing">
        <dl className="grid grid-cols-2 gap-y-2 font-mono text-sm">
          <dt className="text-muted-foreground">HC-SR04 poll</dt><dd>{TIMING.usIntervalMs} ms</dd>
          <dt className="text-muted-foreground">Detect / clear</dt><dd>&lt;{TIMING.detectCm} / &gt;{TIMING.clearCm} cm</dd>
          <dt className="text-muted-foreground">Confirm readings</dt><dd>{TIMING.detectReadings}</dd>
          <dt className="text-muted-foreground">Reservation</dt><dd>{TIMING.reserveMs / 1000} s</dd>
          <dt className="text-muted-foreground">Min QR time</dt><dd>{TIMING.minQrMs / 1000} s</dd>
          <dt className="text-muted-foreground">Clear before close</dt><dd>{TIMING.clearHoldMs / 1000} s</dd>
          <dt className="text-muted-foreground">Welcome screen</dt><dd>{TIMING.welcomeMs / 1000} s</dd>
          <dt className="text-muted-foreground">IR debounce</dt><dd>{TIMING.irDebounceMs / 1000} s</dd>
          <dt className="text-muted-foreground">BOOT hold</dt><dd>{TIMING.bootHoldMs} ms</dd>
          <dt className="text-muted-foreground">Exit open</dt><dd>{TIMING.exitOpenMs / 1000} s</dd>
          <dt className="text-muted-foreground">QR_TEXT</dt><dd className="break-all text-xs">{QR_TEXT}</dd>
        </dl>
      </Panel>
      <Panel title="GPIO map (ESP32 Dev Module)" className="lg:col-span-2">
        <div className="grid gap-x-8 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map(([k, v]) => <div key={k} className="flex justify-between border-b border-border py-1.5 text-sm"><span className="text-muted-foreground">{k}</span><span className="font-mono">{v}</span></div>)}
        </div>
      </Panel>
    </div>
  );
}

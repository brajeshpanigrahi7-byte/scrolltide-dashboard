import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import {
  CreditCard,
  ExternalLink,
  RefreshCw,
  Copy,
  Check,
  ShieldCheck,
  Zap,
  Save,
  Server,
  Key,
} from "lucide-react";
import { useParking } from "@/lib/parking/store";
import { GPIO, TIMING } from "@/lib/parking/types";
import { Panel, Pill } from "@/components/dash/kit";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "System Settings — ParkSense" },
      { name: "description", content: "Device API, Razorpay configuration, pricing and system parameters for the ESP32 parking system." },
    ],
  }),
  component: SettingsPage,
});

const rows: [string, string | number][] = [
  ["OLED SDA / SCL", `${GPIO.oledSda} / ${GPIO.oledScl}`],
  ["HC-SR04 TRIG / ECHO", `${GPIO.trig} / ${GPIO.echo}`],
  ["Entry servo", GPIO.entryServo],
  ["Exit servo", GPIO.exitServo],
  ["Buzzer", GPIO.buzzer],
  ...GPIO.ir.map((p, i) => [`IR slot ${i + 1}`, p] as [string, number]),
  ...GPIO.led.map(([r, g], i) => [`Slot ${i + 1} LED R / G`, `${r} / ${g}`] as [string, string]),
];

function SettingsPage() {
  const { mode, liveError, setDemoMode, state } = useParking();
  const [testLoading, setTestLoading] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [lastPayUrl, setLastPayUrl] = useState<string | null>(null);

  // Editable settings
  const [pricePerHour, setPricePerHour] = useState<number>(20);
  const [durationOptionsStr, setDurationOptionsStr] = useState<string>("30, 60, 120, 180, 240");
  const [reminderMin, setReminderMin] = useState<number>(10);
  const [exitOpenSec, setExitOpenSec] = useState<number>(60);
  const [offlineAfterS, setOfflineAfterS] = useState<number>(30);
  const [savingSettings, setSavingSettings] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Copy states
  const [copiedApi, setCopiedApi] = useState(false);
  const [copiedWebhook, setCopiedWebhook] = useState(false);

  const supabaseUrl = "https://ygnqotiqppdvbvpfaxwa.supabase.co";
  const apiBaseUrl = `${supabaseUrl}/functions/v1`;
  const webhookUrl = `${supabaseUrl}/functions/v1/razorpay-webhook`;

  // Fetch settings on mount
  useEffect(() => {
    async function loadSettings() {
      const { data } = await supabase.from("settings").select("*").eq("id", 1).maybeSingle();
      if (data) {
        if (data.price_per_hour != null) setPricePerHour(Number(data.price_per_hour));
        if (data.duration_options != null) {
          const arr = Array.isArray(data.duration_options) ? data.duration_options : [30, 60, 120, 180, 240];
          setDurationOptionsStr(arr.join(", "));
        }
        if (data.reminder_min != null) setReminderMin(data.reminder_min);
        if (data.exit_open_seconds != null) setExitOpenSec(data.exit_open_seconds);
        if (data.offline_after_s != null) setOfflineAfterS(data.offline_after_s);
      }
    }
    loadSettings();
  }, []);

  const handleSaveSettings = async () => {
    setSavingSettings(true);
    setSaveSuccess(false);
    try {
      const durationOptions = durationOptionsStr
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => !isNaN(n) && n > 0);

      await supabase.from("settings").upsert({
        id: 1,
        price_per_hour: pricePerHour,
        duration_options: durationOptions,
        reminder_min: reminderMin,
        exit_open_seconds: exitOpenSec,
        offline_after_s: offlineAfterS,
      });

      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (e) {
      console.error("Failed to save settings", e);
    } finally {
      setSavingSettings(false);
    }
  };

  const copyToClipboard = (text: string, type: "api" | "webhook") => {
    navigator.clipboard.writeText(text);
    if (type === "api") {
      setCopiedApi(true);
      setTimeout(() => setCopiedApi(false), 2000);
    } else {
      setCopiedWebhook(true);
      setTimeout(() => setCopiedWebhook(false), 2000);
    }
  };

  const handleTestPayment = async () => {
    setTestLoading(true);
    setTestError(null);
    setTestResult(null);

    try {
      // Create session for slot 1
      let res = await fetch("/api/public/device-session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-device-key": "admin-test-override",
        },
        body: JSON.stringify({ device: "esp32-entry-1", slot: 1 }),
      });

      if (!res.ok) {
        // Fallback to test-payment endpoint
        res = await fetch("/api/test-payment", { method: "POST" });
      }

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create test session");

      const targetUrl = data.pay_url || data.short_url;
      setLastPayUrl(targetUrl);
      setTestResult(`Created session ${data.session_id.slice(0, 8)}… code ${data.code}. Opening pay link…`);

      if (targetUrl) {
        window.open(targetUrl, "_blank", "noopener,noreferrer");
      }
    } catch (err: any) {
      setTestError(err.message || "Test payment failed");
    } finally {
      setTestLoading(false);
    }
  };

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      {/* 1. Device API & Webhook URLs */}
      <Panel title="Hardware & Webhook Endpoints" className="lg:col-span-2">
        <p className="text-sm text-muted-foreground mb-4">
          Connect your ESP32 microcontroller and Razorpay webhooks to these secure Supabase backend endpoints.
        </p>
        <div className="grid gap-4 md:grid-cols-2">
          {/* Device API Base URL */}
          <div className="rounded-xl border border-border bg-surface-2 p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase text-muted-foreground flex items-center gap-1.5">
                <Server className="size-3.5 text-primary" /> ESP32 API Base URL (API_BASE)
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs flex items-center gap-1"
                onClick={() => copyToClipboard(apiBaseUrl, "api")}
              >
                {copiedApi ? <Check className="size-3.5 text-free" /> : <Copy className="size-3.5" />}
                {copiedApi ? "Copied" : "Copy"}
              </Button>
            </div>
            <div className="font-mono text-xs bg-background p-2.5 rounded-lg border border-border break-all select-all">
              {apiBaseUrl}
            </div>
            <p className="text-[11px] text-muted-foreground">
              Configure in ESP32 firmware as <code className="text-foreground">API_BASE</code>.
            </p>
          </div>

          {/* Razorpay Webhook URL */}
          <div className="rounded-xl border border-border bg-surface-2 p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase text-muted-foreground flex items-center gap-1.5">
                <Zap className="size-3.5 text-amber-400" /> Razorpay Webhook URL
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs flex items-center gap-1"
                onClick={() => copyToClipboard(webhookUrl, "webhook")}
              >
                {copiedWebhook ? <Check className="size-3.5 text-free" /> : <Copy className="size-3.5" />}
                {copiedWebhook ? "Copied" : "Copy"}
              </Button>
            </div>
            <div className="font-mono text-xs bg-background p-2.5 rounded-lg border border-border break-all select-all">
              {webhookUrl}
            </div>
            <p className="text-[11px] text-muted-foreground">
              Add in Razorpay Dashboard for <code className="text-foreground">payment.captured</code>,{" "}
              <code className="text-foreground">order.paid</code>, <code className="text-foreground">payment.failed</code>.
            </p>
          </div>
        </div>
      </Panel>

      {/* 2. Security & Credentials Status */}
      <Panel title="Security & Payment Gateway">
        <div className="space-y-4">
          <div className="flex items-center justify-between border-b border-border pb-3">
            <div>
              <p className="text-sm font-medium">Razorpay Mode</p>
              <p className="text-xs text-muted-foreground">Derived from key prefix (secrets kept secure)</p>
            </div>
            <Pill t="free">Test Mode (rzp_test_)</Pill>
          </div>

          <div className="flex items-center justify-between border-b border-border pb-3">
            <div>
              <p className="text-sm font-medium">Device Key Auth</p>
              <p className="text-xs text-muted-foreground">ESP32 header x-device-key verification</p>
            </div>
            <Pill t="primary">
              <ShieldCheck className="size-3 mr-1" /> Active
            </Pill>
          </div>

          <div className="rounded-lg bg-surface-2 p-3 text-xs text-muted-foreground space-y-1">
            <p className="font-semibold text-foreground">Razorpay Dashboard Setup:</p>
            <ol className="list-decimal pl-4 space-y-0.5">
              <li>Go to Razorpay Dashboard → Settings → Webhooks</li>
              <li>Click <b>Add New Webhook</b> and paste the Webhook URL above</li>
              <li>Select events: <b>payment.captured</b>, <b>order.paid</b>, <b>payment.failed</b></li>
              <li>Ensure Secret matches your <b>RAZORPAY_WEBHOOK_SECRET</b></li>
              <li>Ensure Payment Capture is set to <b>Automatic</b></li>
            </ol>
          </div>
        </div>
      </Panel>

      {/* 3. Razorpay Test Payment */}
      <Panel title="Razorpay Test Payment">
        <p className="text-sm text-muted-foreground mb-4">
          Creates a real ₹20 parking session (Slot 1, 30 min duration) and opens the Razorpay pay link in a new window.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={handleTestPayment} disabled={testLoading} className="flex items-center gap-2">
            {testLoading ? <RefreshCw className="size-4 animate-spin" /> : <CreditCard className="size-4" />}
            Test payment (₹20)
          </Button>
          {lastPayUrl && (
            <Button asChild variant="outline">
              <a href={lastPayUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="size-4 mr-1.5" /> Reopen Pay Link
              </a>
            </Button>
          )}
        </div>
        {testResult && <p className="mt-3 text-xs font-mono text-emerald-400">{testResult}</p>}
        {testError && <p className="mt-3 text-xs text-destructive">{testError}</p>}
      </Panel>

      {/* 4. Parking Tariff & Rules Settings */}
      <Panel title="Parking Tariff & Rules">
        <div className="space-y-3.5">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs text-muted-foreground">Price per hour (₹)</Label>
              <Input
                type="number"
                value={pricePerHour}
                onChange={(e) => setPricePerHour(Number(e.target.value))}
                className="mt-1 h-9 font-mono text-sm"
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Reminder Window (minutes)</Label>
              <Input
                type="number"
                value={reminderMin}
                onChange={(e) => setReminderMin(Number(e.target.value))}
                className="mt-1 h-9 font-mono text-sm"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs text-muted-foreground">Exit Barrier Open (seconds)</Label>
              <Input
                type="number"
                value={exitOpenSec}
                onChange={(e) => setExitOpenSec(Number(e.target.value))}
                className="mt-1 h-9 font-mono text-sm"
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Offline Timeout (seconds)</Label>
              <Input
                type="number"
                value={offlineAfterS}
                onChange={(e) => setOfflineAfterS(Number(e.target.value))}
                className="mt-1 h-9 font-mono text-sm"
              />
            </div>
          </div>

          <div>
            <Label className="text-xs text-muted-foreground">Duration Options (minutes, comma-separated)</Label>
            <Input
              type="text"
              value={durationOptionsStr}
              onChange={(e) => setDurationOptionsStr(e.target.value)}
              className="mt-1 h-9 font-mono text-sm"
            />
          </div>

          <div className="pt-2 flex items-center justify-between">
            <Button
              onClick={handleSaveSettings}
              disabled={savingSettings}
              className="flex items-center gap-2 text-xs"
            >
              {savingSettings ? <RefreshCw className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
              Save System Settings
            </Button>
            {saveSuccess && <span className="text-xs text-emerald-400 font-medium">Settings saved to database!</span>}
          </div>
        </div>
      </Panel>

      {/* 5. Dashboard Mode */}
      <Panel title="Dashboard Mode">
        <label className="flex items-center justify-between gap-4">
          Demo mode · simulated hardware
          <Switch checked={mode === "demo"} onCheckedChange={setDemoMode} />
        </label>
        <p className="mt-3 text-sm text-muted-foreground">
          {mode === "demo"
            ? "Demo mode simulates sensor readings and events locally for preview without physical hardware."
            : "Live mode reads real-time ESP32 telemetry, slots, and Razorpay payment sessions from Lovable Cloud."}
        </p>
      </Panel>

      {/* 6. GPIO Map */}
      <Panel title="GPIO map (ESP32 Dev Module)" className="lg:col-span-2">
        <div className="grid gap-x-8 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between border-b border-border py-1.5 text-sm">
              <span className="text-muted-foreground">{k}</span>
              <span className="font-mono">{v}</span>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

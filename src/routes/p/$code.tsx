import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useRef } from "react";
import {
  Car,
  Clock,
  ShieldCheck,
  CheckCircle2,
  AlertTriangle,
  Sparkles,
  ChevronRight,
  Phone,
  Mail,
  RefreshCw,
  PlusCircle,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DEFAULT_SETTINGS, durationOptions, pricePaise } from "@/lib/parking/payments";

declare global {
  interface Window {
    Razorpay?: any;
  }
}

export const Route = createFileRoute("/p/$code")({
  head: () => ({
    meta: [
      { title: "ParkSense — Driver Payment" },
      { name: "viewport", content: "width=device-width, initial-scale=1, maximum-scale=1" },
    ],
    scripts: [
      {
        src: "https://checkout.razorpay.com/v1/checkout.js",
        async: true,
      },
    ],
  }),
  component: DriverPaymentPage,
});

interface SessionData {
  slot: number;
  status: "pending" | "paid" | "active" | "completed" | "expired" | "cancelled" | string;
  duration_min: number;
  amount: number;
  seconds_remaining: number;
  expires_in: number;
  price_options: { duration_min: number; amount: number }[];
  payment_id: string | null;
}

function DriverPaymentPage() {
  const { code } = Route.useParams();
  const [session, setSession] = useState<SessionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedDuration, setSelectedDuration] = useState<number>(30);
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [extending, setExtending] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [receivedAt, setReceivedAt] = useState(Date.now());

  // Poll clock for countdown
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Fetch session status
  const fetchSession = async () => {
    try {
      const res = await fetch(`/api/public/session-status?code=${code}`);
      if (!res.ok) {
        if (res.status === 404) throw new Error("Parking session not found. Check your code.");
        throw new Error("Could not load session.");
      }
      const data: SessionData = await res.json();
      setSession(data);
      setReceivedAt(Date.now());
      if (data.duration_min) setSelectedDuration(data.duration_min);
      setError(null);
    } catch (err: any) {
      setError(err.message || "Error fetching session");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSession();
    // Poll every 3 seconds to auto-update status when gate/payment events arrive
    const pollInterval = setInterval(fetchSession, 3000);
    return () => clearInterval(pollInterval);
  }, [code]);

  // Open Razorpay Checkout for Order
  const handlePay = async () => {
    if (!session) return;
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch("/api/public/create-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          duration_min: selectedDuration,
          kind: "new",
          contact_email: email.trim() || undefined,
          contact_phone: phone.trim() || undefined,
        }),
      });

      const orderData = await res.json();
      if (!res.ok) throw new Error(orderData.error || "Order creation failed.");

      if (window.Razorpay && orderData.order_id && orderData.key_id) {
        const rzp = new window.Razorpay({
          key: orderData.key_id,
          amount: orderData.amount,
          currency: orderData.currency || "INR",
          name: "ParkSense Smart Parking",
          description: `Slot ${session.slot} · ${selectedDuration} min parking`,
          order_id: orderData.order_id,
          prefill: {
            email: email.trim() || undefined,
            contact: phone.trim() || undefined,
          },
          theme: { color: "#10b981" },
          handler: async (response: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => {
            const verification = await fetch("/api/public/verify-payment", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(response),
            });
            if (!verification.ok) {
              const result = await verification.json();
              setError(result.error || "Payment confirmation is still processing.");
            }
            await fetchSession();
          },
        });
        rzp.open();
      } else {
        throw new Error("Razorpay Checkout failed to initialize.");
      }
    } catch (err: any) {
      setError(err.message || "Payment initialization failed.");
    } finally {
      setSubmitting(false);
    }
  };

  // Extend Session
  const handleExtend = async (extraMinutes: number) => {
    if (!session) return;
    setExtending(true);
    setError(null);

    try {
      const res = await fetch("/api/public/extend-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          duration_min: extraMinutes,
          kind: "extend",
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not extend session.");

      if (window.Razorpay && data.order_id && data.key_id) {
        const rzp = new window.Razorpay({
          key: data.key_id,
          amount: data.amount,
          currency: data.currency || "INR",
          name: "ParkSense Extension",
          description: data.description,
          order_id: data.order_id,
          theme: { color: "#10b981" },
          handler: async (response: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => {
            const verification = await fetch("/api/public/verify-payment", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(response),
            });
            if (!verification.ok) {
              const result = await verification.json();
              setError(result.error || "Extension confirmation is still processing.");
            }
            await fetchSession();
          },
        });
        rzp.open();
      }
    } catch (err: any) {
      setError(err.message || "Extension failed.");
    } finally {
      setExtending(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="flex items-center gap-3 text-muted-foreground">
          <RefreshCw className="size-5 animate-spin" />
          <span>Connecting to parking barrier…</span>
        </div>
      </div>
    );
  }

  if (error && !session) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="w-full max-w-sm rounded-2xl border border-destructive/20 bg-card p-6 text-center shadow-lg">
          <AlertTriangle className="mx-auto size-12 text-destructive mb-3" />
          <h2 className="text-lg font-semibold text-foreground">Session Error</h2>
          <p className="mt-2 text-sm text-muted-foreground">{error}</p>
          <Button onClick={fetchSession} className="mt-6 w-full" variant="outline">
            Try Again
          </Button>
        </div>
      </div>
    );
  }

  const options = session?.price_options?.length
    ? session.price_options.map((option) => ({ minutes: option.duration_min, amount: option.amount / 100 }))
    : durationOptions();
  const amount = options.find((option) => option.minutes === selectedDuration)?.amount
    ?? pricePaise(selectedDuration, DEFAULT_SETTINGS.price_per_hour) / 100;

  const remainingMs = Math.max(0, (session?.seconds_remaining ?? 0) * 1000 - (now - receivedAt));
  const remainingMinutes = Math.floor(remainingMs / 60000);
  const remainingSeconds = Math.floor((remainingMs % 60000) / 1000);

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-between p-4 sm:p-6 font-sans">
      {/* Brand Header */}
      <header className="flex items-center justify-between border-b border-border/40 pb-4">
        <div className="flex items-center gap-2">
          <div className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground font-bold shadow-md">
            P
          </div>
          <div>
            <h1 className="text-base font-bold tracking-tight">ParkSense</h1>
            <p className="text-[11px] font-mono text-muted-foreground">Gate Pay & Pass</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 rounded-full bg-secondary/80 px-3 py-1 text-xs font-mono">
          <span className="text-muted-foreground">CODE:</span>
          <span className="font-bold text-foreground">{code}</span>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="my-auto py-6">
        {/* State 1: Awaiting Payment */}
        {session?.status === "pending" && (
          <div className="space-y-6 animate-in fade-in zoom-in-95 duration-300">
            {/* Slot Announcement Card */}
            <div className="rounded-2xl border border-primary/20 bg-primary/5 p-6 text-center shadow-sm">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
                <Car className="size-3.5" /> Barrier Ready
              </span>
              <div className="mt-3 text-4xl font-extrabold tracking-tight text-foreground">
                Slot {session.slot}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Reserved for your vehicle · Rate ₹{DEFAULT_SETTINGS.price_per_hour} / hour
              </p>
            </div>

            {/* Duration Selector */}
            <div className="space-y-3">
              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Select Parking Duration
              </Label>
              <div className="grid grid-cols-2 gap-2">
                {options.map((opt) => {
                  const isSelected = selectedDuration === opt.minutes;
                  return (
                    <button
                      key={opt.minutes}
                      type="button"
                      onClick={() => setSelectedDuration(opt.minutes)}
                      className={`flex items-center justify-between rounded-xl border p-3 text-left transition-all ${
                        isSelected
                          ? "border-primary bg-primary/10 text-foreground ring-2 ring-primary/30"
                          : "border-border/60 bg-card hover:border-primary/40 text-muted-foreground"
                      }`}
                    >
                      <span className="text-xs font-medium">{opt.minutes} mins</span>
                      <span className="font-mono text-xs font-bold text-foreground">₹{opt.amount}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Reminder Details (Optional) */}
            <div className="space-y-3 rounded-2xl border border-border/60 bg-card p-4">
              <span className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
                <Clock className="size-3.5" /> Expiry Reminders (Optional)
              </span>
              <div className="space-y-2">
                <div className="relative">
                  <Mail className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
                  <Input
                    type="email"
                    placeholder="driver@example.com"
                    className="pl-9 text-xs"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
                <div className="relative">
                  <Phone className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
                  <Input
                    type="tel"
                    placeholder="10-digit mobile number"
                    className="pl-9 text-xs"
                    value={phone}
                    maxLength={10}
                    onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))}
                  />
                </div>
              </div>
            </div>

            {error && <p className="text-center text-xs text-destructive">{error}</p>}

            {/* Payment Button */}
            <Button
              onClick={handlePay}
              disabled={submitting}
              className="w-full h-12 text-base font-semibold shadow-md"
            >
              {submitting ? (
                <>
                  <RefreshCw className="mr-2 size-4 animate-spin" /> Preparing Checkout…
                </>
              ) : (
                <>Pay ₹{amount} & Open Barrier</>
              )}
            </Button>
          </div>
        )}

        {/* State 2: Paid (Gate Opening) */}
        {session?.status === "paid" && (
          <div className="rounded-3xl border border-emerald-500/30 bg-emerald-500/10 p-8 text-center animate-in zoom-in-95 duration-500 shadow-xl">
            <div className="mx-auto mb-4 grid size-16 place-items-center rounded-2xl bg-emerald-500 text-white shadow-lg shadow-emerald-500/20">
              <CheckCircle2 className="size-10 animate-bounce" />
            </div>
            <h2 className="text-2xl font-bold text-foreground">Payment Confirmed!</h2>
            <p className="mt-3 text-lg font-semibold text-emerald-400">
              Gate is opening, drive to slot {session.slot}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              Please enter within 60 seconds. The entry barrier is raised.
            </p>
          </div>
        )}

        {/* State 3: Active Parking Session */}
        {session?.status === "active" && (
          <div className="space-y-6 animate-in fade-in duration-300">
            {/* Active Card with Countdown */}
            <div className="rounded-3xl border border-primary/30 bg-card p-6 text-center shadow-lg">
              <div className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-3 py-1 text-xs font-semibold text-emerald-400">
                <span className="size-2 rounded-full bg-emerald-400 animate-pulse" /> Parked in Slot {session.slot}
              </div>

              <div className="mt-6">
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Time Remaining
                </p>
                <div className="mt-2 font-mono text-5xl font-extrabold tracking-tight text-foreground">
                  {String(remainingMinutes).padStart(2, "0")}:{String(remainingSeconds).padStart(2, "0")}
                </div>
              </div>

              {remainingMinutes <= 10 && remainingMs > 0 && (
                <div className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-warning/15 px-3 py-1.5 text-xs font-medium text-warning">
                  <AlertTriangle className="size-3.5" /> Ending soon! Extend before time expires.
                </div>
              )}

              {remainingMs === 0 && (
                <div className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-destructive/15 px-3 py-1.5 text-xs font-medium text-destructive">
                  <AlertTriangle className="size-3.5" /> Time expired! Exit barrier will open automatically.
                </div>
              )}
            </div>

            {/* Extend Buttons */}
            <div className="rounded-2xl border border-border/60 bg-card p-5 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                  <PlusCircle className="size-3.5 text-primary" /> Extend Session
                </span>
                <span className="text-[11px] text-muted-foreground">Paid securely with Razorpay</span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Button
                  variant="outline"
                  disabled={extending}
                  onClick={() => handleExtend(30)}
                  className="flex flex-col h-14"
                >
                  <span className="text-xs font-bold">+30 Minutes</span>
                  <span className="text-[10px] text-muted-foreground">₹{pricePaise(30, DEFAULT_SETTINGS.price_per_hour) / 100}</span>
                </Button>
                <Button
                  variant="outline"
                  disabled={extending}
                  onClick={() => handleExtend(60)}
                  className="flex flex-col h-14"
                >
                  <span className="text-xs font-bold">+60 Minutes</span>
                  <span className="text-[10px] text-muted-foreground">₹{pricePaise(60, DEFAULT_SETTINGS.price_per_hour) / 100}</span>
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* State 4: Completed */}
        {session?.status === "completed" && (
          <div className="rounded-2xl border border-border bg-card p-6 text-center shadow-md">
            <CheckCircle2 className="mx-auto size-12 text-primary mb-3" />
            <h2 className="text-lg font-bold text-foreground">Session Completed</h2>
            <p className="mt-2 text-xs text-muted-foreground">
              Thank you for parking with ParkSense at Slot {session.slot}. Have a safe journey!
            </p>
          </div>
        )}

        {/* State 5: Expired or Cancelled */}
        {(session?.status === "expired" || session?.status === "cancelled") && (
          <div className="rounded-2xl border border-destructive/20 bg-card p-6 text-center shadow-md">
            <AlertTriangle className="mx-auto size-12 text-destructive mb-3" />
            <h2 className="text-lg font-bold text-foreground">
              Session {session.status === "cancelled" ? "Cancelled" : "Expired"}
            </h2>
            <p className="mt-2 text-xs text-muted-foreground">
              This session is no longer active. Pull up to the gate sensor to generate a new QR code.
            </p>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="pt-4 border-t border-border/40 text-center text-[11px] text-muted-foreground flex items-center justify-between">
        <span className="flex items-center gap-1">
          <ShieldCheck className="size-3 text-emerald-400" /> Razorpay Verified
        </span>
        <span>ParkSense ESP32</span>
      </footer>
    </div>
  );
}

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
  LogOut,
  Bell,
  ArrowRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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

interface PriceOption {
  duration_min: number;
  amount_inr: number;
}

interface SessionData {
  session_id?: string;
  code: string;
  slot: number;
  status: "pending" | "paid" | "active" | "completed" | "expired" | "cancelled" | string;
  duration_min: number;
  seconds_remaining: number;
  amount: number;
  expires_in: number;
  vehicle_no: string | null;
  price_options: PriceOption[];
  price_per_hour: number;
}

function DriverPaymentPage() {
  const { code } = Route.useParams();
  const [session, setSession] = useState<SessionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedDuration, setSelectedDuration] = useState<number>(30);
  const [vehicleNo, setVehicleNo] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [paying, setPaying] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [paymentSuccessMessage, setPaymentSuccessMessage] = useState<string | null>(null);
  const [notifiedTenMin, setNotifiedTenMin] = useState(false);

  // Request browser notification permission once
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, []);

  const fetchSession = async () => {
    try {
      // Try local server route first, fallback to Supabase Edge Function
      let res = await fetch(`/api/public/session-public?code=${code}`);
      if (!res.ok && res.status !== 404) {
        res = await fetch(
          `https://ygnqotiqppdvbvpfaxwa.supabase.co/functions/v1/session-public?code=${code}`,
        );
      }

      if (!res.ok) {
        if (res.status === 404)
          throw new Error("Parking session not found. Please check your QR code.");
        throw new Error("Could not load session status.");
      }

      const data: SessionData = await res.json();
      setSession(data);
      if (data.vehicle_no && !vehicleNo) setVehicleNo(data.vehicle_no);

      // Check 10-minute warning notification
      if (
        data.status === "active" &&
        data.seconds_remaining <= 600 &&
        data.seconds_remaining > 0 &&
        !notifiedTenMin
      ) {
        setNotifiedTenMin(true);
        if ("Notification" in window && Notification.permission === "granted") {
          new Notification("ParkSense: 10 Minutes Remaining", {
            body: `Your parking session for slot ${data.slot} will expire in 10 minutes. Extend now if needed.`,
            icon: "/favicon.ico",
          });
        }
      }

      setError(null);
    } catch (err: any) {
      setError(err.message || "Failed to fetch session");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSession();
    const interval = setInterval(fetchSession, 3000);
    return () => clearInterval(interval);
  }, [code]);

  // Open Razorpay Checkout
  const handlePayment = async (durationMin: number, kind: "new" | "extend" = "new") => {
    setPaying(true);
    setError(null);
    try {
      let orderRes = await fetch("/api/public/create-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          duration_min: durationMin,
          kind,
          vehicle_no: vehicleNo.trim() || undefined,
          contact_email: email.trim() || undefined,
          contact_phone: phone.trim() || undefined,
        }),
      });

      if (!orderRes.ok) {
        orderRes = await fetch(
          "https://ygnqotiqppdvbvpfaxwa.supabase.co/functions/v1/create-order",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              code,
              duration_min: durationMin,
              kind,
              vehicle_no: vehicleNo.trim() || undefined,
              contact_email: email.trim() || undefined,
              contact_phone: phone.trim() || undefined,
            }),
          },
        );
      }

      if (!orderRes.ok) {
        const errJson = await orderRes.json().catch(() => ({}));
        throw new Error(errJson.error || "Failed to initiate payment");
      }

      const orderData = await orderRes.json();

      if (!window.Razorpay) {
        throw new Error("Razorpay SDK not loaded. Please refresh.");
      }

      const options = {
        key: orderData.key_id,
        amount: orderData.amount,
        currency: orderData.currency || "INR",
        name: "ParkSense",
        description: `Slot ${session?.slot} — ${durationMin} min`,
        order_id: orderData.order_id,
        prefill: {
          email: email.trim() || undefined,
          contact: phone.trim() || undefined,
        },
        theme: { color: "#22c55e" },
        handler: async (response: any) => {
          try {
            let verifyRes = await fetch("/api/public/verify-payment", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                razorpay_order_id: response.razorpay_order_id,
                razorpay_payment_id: response.razorpay_payment_id,
                razorpay_signature: response.razorpay_signature,
              }),
            });

            if (!verifyRes.ok) {
              verifyRes = await fetch(
                "https://ygnqotiqppdvbvpfaxwa.supabase.co/functions/v1/verify-payment",
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    razorpay_order_id: response.razorpay_order_id,
                    razorpay_payment_id: response.razorpay_payment_id,
                    razorpay_signature: response.razorpay_signature,
                  }),
                },
              );
            }

            setPaymentSuccessMessage("Payment received, the gate is opening...");
            fetchSession();
          } catch (verErr: any) {
            console.error("Verification error", verErr);
          }
        },
        modal: {
          ondismiss: () => {
            setPaying(false);
          },
        },
      };

      const rzp = new window.Razorpay(options);
      rzp.open();
    } catch (err: any) {
      setError(err.message || "Payment initiation failed");
      setPaying(false);
    }
  };

  // Driver clicks "I'm leaving now"
  const handleLeaveNow = async () => {
    if (!confirm("Are you ready to leave now? The exit gate will open for you.")) return;
    setLeaving(true);
    try {
      const payload = { code, session_id: session?.session_id };
      let res = await fetch("/api/public/leave-now", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        res = await fetch("https://ygnqotiqppdvbvpfaxwa.supabase.co/functions/v1/leave-now", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      }
      fetchSession();
    } catch (err) {
      console.error(err);
    } finally {
      setLeaving(false);
    }
  };

  const formatCountdown = (totalSeconds: number) => {
    const s = Math.max(0, totalSeconds);
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = s % 60;
    if (hrs > 0) {
      return `${hrs.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
    }
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  const durationOptionsList = session?.price_options || [
    { duration_min: 30, amount_inr: 20 },
    { duration_min: 60, amount_inr: 40 },
    { duration_min: 120, amount_inr: 80 },
    { duration_min: 180, amount_inr: 120 },
    { duration_min: 240, amount_inr: 160 },
  ];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center p-4 selection:bg-emerald-500/20">
      <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden p-6 space-y-6">
        {/* Brand header */}
        <div className="flex items-center justify-between border-b border-slate-800/80 pb-4">
          <div className="flex items-center gap-2.5">
            <div className="size-9 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
              <Car className="size-5" />
            </div>
            <div>
              <h1 className="font-semibold tracking-tight text-base">ParkSense</h1>
              <p className="text-xs text-slate-400">Smart Automated Parking</p>
            </div>
          </div>
          <div className="font-mono text-xs px-2.5 py-1 rounded-md bg-slate-800 text-slate-300 font-medium">
            {code}
          </div>
        </div>

        {loading ? (
          <div className="py-12 flex flex-col items-center justify-center gap-3 text-slate-400">
            <RefreshCw className="size-6 animate-spin text-emerald-500" />
            <p className="text-xs font-medium">Loading session...</p>
          </div>
        ) : error ? (
          <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-sm space-y-2">
            <div className="flex items-center gap-2 font-medium">
              <AlertTriangle className="size-4 shrink-0 text-rose-400" />
              <span>Error</span>
            </div>
            <p className="text-xs text-rose-300/90">{error}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={fetchSession}
              className="mt-2 text-xs border-rose-500/30 text-rose-300 hover:bg-rose-500/20"
            >
              Retry
            </Button>
          </div>
        ) : !session ? null : (
          <>
            {/* STATE 1: PENDING */}
            {session.status === "pending" && (
              <div className="space-y-5">
                <div className="rounded-xl bg-slate-800/60 border border-slate-700/50 p-4 text-center">
                  <p className="text-xs text-slate-400 uppercase tracking-wider font-semibold">
                    Assigned Slot
                  </p>
                  <p className="text-4xl font-extrabold text-emerald-400 mt-1">
                    Slot {session.slot}
                  </p>
                  <div className="mt-3 inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs font-mono font-medium">
                    <Clock className="size-3.5" />
                    <span>Pay within {formatCountdown(session.expires_in)}</span>
                  </div>
                </div>

                {paymentSuccessMessage && (
                  <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs font-medium text-center">
                    {paymentSuccessMessage}
                  </div>
                )}

                {/* Duration options */}
                <div className="space-y-2.5">
                  <Label className="text-xs text-slate-300 font-medium">
                    Select Parking Duration
                  </Label>
                  <div className="grid grid-cols-2 gap-2">
                    {durationOptionsList.map((opt) => (
                      <button
                        key={opt.duration_min}
                        type="button"
                        onClick={() => setSelectedDuration(opt.duration_min)}
                        className={`p-3 rounded-xl border text-left transition-all ${
                          selectedDuration === opt.duration_min
                            ? "bg-emerald-500/15 border-emerald-500 text-emerald-300 shadow-sm"
                            : "bg-slate-800/40 border-slate-700/60 text-slate-300 hover:border-slate-600"
                        }`}
                      >
                        <div className="text-xs font-semibold">
                          {opt.duration_min >= 60
                            ? `${opt.duration_min / 60} hr`
                            : `${opt.duration_min} min`}
                        </div>
                        <div className="text-base font-bold text-slate-100 mt-0.5">
                          ₹{opt.amount_inr}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Optional vehicle number and contact */}
                <div className="space-y-3 pt-1">
                  <div>
                    <Label className="text-xs text-slate-400 font-normal">
                      Vehicle Number (Optional)
                    </Label>
                    <Input
                      placeholder="e.g. MH 02 AB 1234"
                      value={vehicleNo}
                      onChange={(e) => setVehicleNo(e.target.value.toUpperCase())}
                      className="mt-1 h-9 bg-slate-800/50 border-slate-700 text-xs uppercase"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs text-slate-400 font-normal">Email (Optional)</Label>
                      <Input
                        type="email"
                        placeholder="For reminder"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className="mt-1 h-9 bg-slate-800/50 border-slate-700 text-xs"
                      />
                    </div>
                    <div>
                      <Label className="text-xs text-slate-400 font-normal">Phone (Optional)</Label>
                      <Input
                        type="tel"
                        placeholder="10 digits"
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        className="mt-1 h-9 bg-slate-800/50 border-slate-700 text-xs"
                      />
                    </div>
                  </div>
                </div>

                <Button
                  onClick={() => handlePayment(selectedDuration, "new")}
                  disabled={paying}
                  className="w-full h-11 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold rounded-xl text-sm shadow-lg shadow-emerald-950/50 flex items-center justify-center gap-2"
                >
                  {paying ? (
                    <>
                      <RefreshCw className="size-4 animate-spin" />
                      <span>Processing Payment...</span>
                    </>
                  ) : (
                    <>
                      <span>
                        Pay ₹
                        {durationOptionsList.find((x) => x.duration_min === selectedDuration)
                          ?.amount_inr || 20}{" "}
                        with Razorpay
                      </span>
                      <ArrowRight className="size-4" />
                    </>
                  )}
                </Button>
              </div>
            )}

            {/* STATE 2: PAID (WAITING FOR ENTRY) */}
            {session.status === "paid" && (
              <div className="space-y-5 text-center py-4">
                <div className="size-16 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 mx-auto">
                  <CheckCircle2 className="size-8" />
                </div>
                <div>
                  <h2 className="text-xl font-bold text-slate-100">Gate is Opening!</h2>
                  <p className="text-sm text-emerald-400 font-medium mt-1">
                    Please drive to Slot {session.slot}
                  </p>
                </div>
                <div className="p-4 rounded-xl bg-slate-800/40 border border-slate-700/60 text-xs text-slate-400 space-y-1">
                  <p>Your barrier is opening automatically.</p>
                  <p>Once parked, the parking countdown timer will start.</p>
                </div>
              </div>
            )}

            {/* STATE 3: ACTIVE */}
            {session.status === "active" && (
              <div className="space-y-5">
                {/* 10 minute warning banner */}
                {session.seconds_remaining <= 600 && session.seconds_remaining > 0 && (
                  <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs flex items-center gap-2.5">
                    <Bell className="size-4 shrink-0 text-amber-400 animate-bounce" />
                    <span>Under 10 minutes remaining! Extend now or prepare to leave.</span>
                  </div>
                )}

                <div className="rounded-2xl bg-gradient-to-b from-slate-800/80 to-slate-900 border border-slate-700/80 p-6 text-center space-y-2">
                  <p className="text-xs text-slate-400 uppercase tracking-widest font-bold">
                    Remaining Time
                  </p>
                  <p
                    className={`font-mono text-5xl font-black tracking-tight ${
                      session.seconds_remaining <= 600
                        ? "text-amber-400 animate-pulse"
                        : "text-emerald-400"
                    }`}
                  >
                    {formatCountdown(session.seconds_remaining)}
                  </p>
                  <div className="pt-2 flex items-center justify-center gap-3 text-xs text-slate-400">
                    <span className="font-semibold text-slate-300">Slot {session.slot}</span>
                    <span>•</span>
                    <span>Total {session.duration_min} min</span>
                    {session.vehicle_no && (
                      <>
                        <span>•</span>
                        <span className="uppercase text-slate-300">{session.vehicle_no}</span>
                      </>
                    )}
                  </div>
                </div>

                {/* Extend buttons */}
                <div className="space-y-2">
                  <Label className="text-xs text-slate-400 font-medium">Extend Parking Time</Label>
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      variant="outline"
                      onClick={() => handlePayment(30, "extend")}
                      disabled={paying}
                      className="h-10 text-xs border-slate-700 bg-slate-800/50 hover:bg-slate-700 text-slate-200"
                    >
                      <PlusCircle className="size-3.5 mr-1 text-emerald-400" />
                      +30 min (₹20)
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => handlePayment(60, "extend")}
                      disabled={paying}
                      className="h-10 text-xs border-slate-700 bg-slate-800/50 hover:bg-slate-700 text-slate-200"
                    >
                      <PlusCircle className="size-3.5 mr-1 text-emerald-400" />
                      +60 min (₹40)
                    </Button>
                  </div>
                </div>

                {/* I'm leaving now button */}
                <div className="pt-1">
                  <Button
                    variant="secondary"
                    onClick={handleLeaveNow}
                    disabled={leaving}
                    className="w-full h-10 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-xl flex items-center justify-center gap-2 border border-slate-700"
                  >
                    <LogOut className="size-3.5 text-amber-400" />
                    <span>
                      {leaving ? "Signalling exit..." : "I'm leaving now (Open Exit Gate)"}
                    </span>
                  </Button>
                </div>
              </div>
            )}

            {/* STATE 4: COMPLETED */}
            {session.status === "completed" && (
              <div className="space-y-4 text-center py-6">
                <div className="size-14 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center text-slate-300 mx-auto">
                  <CheckCircle2 className="size-7 text-emerald-400" />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-slate-100">Parking Completed</h2>
                  <p className="text-xs text-slate-400 mt-1">
                    Thank you for parking with ParkSense!
                  </p>
                </div>
                <div className="p-4 rounded-xl bg-slate-800/50 border border-slate-700 text-left text-xs space-y-2">
                  <div className="flex justify-between">
                    <span className="text-slate-400">Slot</span>
                    <span className="font-semibold text-slate-200">Slot {session.slot}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Total Duration</span>
                    <span className="font-semibold text-slate-200">
                      {session.duration_min} minutes
                    </span>
                  </div>
                  <div className="flex justify-between border-t border-slate-700/60 pt-2">
                    <span className="text-slate-400">Amount Paid</span>
                    <span className="font-bold text-emerald-400">₹{session.amount}</span>
                  </div>
                </div>
              </div>
            )}

            {/* STATE 5: EXPIRED / CANCELLED */}
            {(session.status === "expired" || session.status === "cancelled") && (
              <div className="space-y-4 text-center py-6">
                <div className="size-14 rounded-full bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-400 mx-auto">
                  <AlertTriangle className="size-7" />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-slate-100">Session {session.status}</h2>
                  <p className="text-xs text-slate-400 mt-1">
                    {session.status === "expired"
                      ? "The 5-minute payment window has expired. Please scan the QR code at the gate again."
                      : "This session has been cancelled."}
                  </p>
                </div>
              </div>
            )}
          </>
        )}

        <div className="border-t border-slate-800/80 pt-3 text-center">
          <p className="text-[11px] text-slate-500">Secured with Razorpay & Supabase Realtime</p>
        </div>
      </div>
    </div>
  );
}

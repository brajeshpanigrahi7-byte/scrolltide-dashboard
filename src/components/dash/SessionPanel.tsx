import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { ExternalLink, IndianRupee, LogIn } from "lucide-react";
import { lovable } from "@/integrations/lovable/index";
import { useSessions } from "@/lib/parking/sessions";
import { effectiveStatus } from "@/lib/parking/payments";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Panel, Pill, StatCard } from "./kit";

export function CollectedTotal() {
  const { total, loading, signedIn, error } = useSessions();
  return <StatCard label="Today's collected · IST" value={loading ? "…" : signedIn && !error ? `₹${total}` : "—"} icon={<IndianRupee className="size-4" />} t="free" sub="Verified Razorpay payments" />;
}
export function SessionPanel({ entry = false }: { entry?: boolean }) {
  const { rows, loading, signedIn, error } = useSessions();
  const [filter, setFilter] = useState("all"); const [search, setSearch] = useState(""); const [authError, setAuthError] = useState<string | null>(null);
  const now = Date.now();
  const filtered = rows.filter((row) => (filter === "all" || effectiveStatus(row, now) === filter) && `${row.slot} ${row.id} ${row.amount_inr}`.includes(search));
  const current = rows.find((row) => effectiveStatus(row, now) === "pending" && row.short_url);
  if (!signedIn) return <Panel title="Live parking payments"><Button onClick={async () => {
    const result = await lovable.auth.signInWithOAuth("lovable", { redirect_uri: window.location.origin });
    if (result.error) setAuthError(result.error.message);
  }}><LogIn />Sign in with Lovable</Button>{authError && <p className="mt-3 text-destructive">{authError}</p>}</Panel>;
  return <div className="space-y-5">
    {entry && <Panel title="Entry payment"><div className="flex flex-wrap items-center gap-6">
      {current?.short_url ? <><div className="rounded-md bg-foreground p-3"><QRCodeSVG value={current.short_url} size={160} /></div><div className="space-y-3"><Pill t="reserved">Pending payment</Pill><p className="text-2xl font-semibold">Slot {current.slot} · ₹{current.amount_inr}</p><p className="text-sm text-muted-foreground">{current.amount_inr / 20 * 30} minutes</p><Button asChild variant="outline"><a href={current.short_url} target="_blank" rel="noopener noreferrer"><ExternalLink />Open Razorpay</a></Button></div></> : <p className="py-6 text-muted-foreground">No pending payment link.</p>}
      <p className="w-full text-sm text-muted-foreground">Entry authorization requires verified payment; actual barrier position comes from the ESP32.</p>
    </div></Panel>}
    <Panel title="Parking sessions">
      <div className="mb-4 flex flex-wrap gap-2">{["all", "pending", "paid", "used", "expired"].map((v) => <Button key={v} size="sm" variant={filter === v ? "default" : "outline"} onClick={() => setFilter(v)}>{v}</Button>)}<Input aria-label="Search sessions" placeholder="Slot, amount or session" className="sm:ml-auto sm:w-64" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
      {error ? <p className="text-destructive">{error}</p> : loading ? <p>Loading sessions…</p> : !filtered.length ? <p className="py-8 text-center text-muted-foreground">No parking sessions yet.</p> : <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-muted-foreground"><tr>{["Slot", "Amount", "Duration", "Status", "Created", "Paid"].map((h) => <th key={h} className="px-3 py-3 font-medium">{h}</th>)}</tr></thead><tbody>{filtered.map((row) => { const status = effectiveStatus(row, now); return <tr key={row.id} className="border-t border-border"><td className="px-3 py-3">{row.slot}</td><td className="px-3 py-3">₹{row.amount_inr}</td><td className="whitespace-nowrap px-3 py-3">{row.amount_inr / 20 * 30} min</td><td className="px-3 py-3"><Pill t={status === "paid" || status === "used" ? "free" : status === "pending" ? "reserved" : "muted"}>{status}</Pill></td><td className="whitespace-nowrap px-3 py-3">{new Date(row.created_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</td><td className="whitespace-nowrap px-3 py-3">{row.paid_at ? new Date(row.paid_at).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" }) : "—"}</td></tr>; })}</tbody></table></div>}
    </Panel>
  </div>;
}
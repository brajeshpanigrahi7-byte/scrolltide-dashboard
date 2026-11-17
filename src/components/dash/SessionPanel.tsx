import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { ExternalLink, IndianRupee, LogIn } from "lucide-react";
import { lovable } from "@/integrations/lovable/index";
import { useSessions } from "@/lib/parking/sessions";
import { effectiveStatus, formatCountdown, payUrl } from "@/lib/parking/payments";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Panel, Pill, StatCard } from "./kit";

export function CollectedTotal() {
  const { total, loading, signedIn, error } = useSessions();
  return <StatCard label="Today's collected · IST" value={loading ? "…" : signedIn && !error ? `₹${total.toFixed(2)}` : "—"}
    icon={<IndianRupee className="size-4" />} t="free" sub="Captured Razorpay payments" />;
}

export function SessionPanel({ entry = false }: { entry?: boolean }) {
  const { rows, loading, signedIn, error } = useSessions();
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const now = Date.now();
  const filtered = rows.filter((row) =>
    (filter === "all" || effectiveStatus(row, now) === filter) &&
    `${row.slot} ${row.code} ${row.vehicle_no ?? ""}`.toLowerCase().includes(search.toLowerCase()));
  const current = rows.find((row) => effectiveStatus(row, now) === "pending");

  if (!signedIn) return <Panel title="Live parking payments">
    <Button onClick={async () => {
      const result = await lovable.auth.signInWithOAuth("lovable", { redirect_uri: window.location.origin });
      if (result.error) setAuthError(result.error.message);
    }}><LogIn />Sign in with Lovable</Button>
    {authError && <p className="mt-3 text-destructive">{authError}</p>}
  </Panel>;

  return <div className="space-y-5">
    {entry && <Panel title="Current entry payment"><div className="flex flex-wrap items-center gap-6">
      {current ? <>
        <div className="rounded-md bg-foreground p-3"><QRCodeSVG value={payUrl(current.code)} size={160} /></div>
        <div className="space-y-3">
          <Pill t="reserved">Pending payment</Pill>
          <p className="text-2xl font-semibold">Slot {current.slot} · {current.code}</p>
          <p className="font-mono text-sm text-reserved">
            {formatCountdown((Date.parse(current.expires_at) - now) / 1000)} remaining
          </p>
          <Button asChild variant="outline"><a href={payUrl(current.code)} target="_blank" rel="noopener noreferrer">
            <ExternalLink />Open driver pay page</a></Button>
        </div>
      </> : <p className="py-6 text-muted-foreground">No pending entry session.</p>}
      <p className="w-full text-sm text-muted-foreground">The entry barrier opens only after verified payment and an ESP32 state update.</p>
    </div></Panel>}

    <Panel title="Recent parking sessions">
      <div className="mb-4 flex flex-wrap gap-2">
        {["all", "pending", "paid", "active", "completed", "expired", "cancelled"].map((value) =>
          <Button key={value} size="sm" variant={filter === value ? "default" : "outline"} onClick={() => setFilter(value)}>{value}</Button>)}
        <Input aria-label="Search sessions" placeholder="Slot, code or vehicle" className="sm:ml-auto sm:w-64"
          value={search} onChange={(event) => setSearch(event.target.value)} />
      </div>
      {error ? <p className="text-destructive">{error}</p> : loading ? <p>Loading sessions…</p> :
        !filtered.length ? <p className="py-8 text-center text-muted-foreground">No parking sessions yet.</p> :
        <div className="overflow-x-auto"><table className="w-full text-left text-sm">
          <thead className="text-muted-foreground"><tr>{["Slot", "Code", "Amount", "Duration", "Status", "Created"].map((heading) =>
            <th key={heading} className="px-3 py-3 font-medium">{heading}</th>)}</tr></thead>
          <tbody>{filtered.map((row) => {
            const status = effectiveStatus(row, now);
            return <tr key={row.id} className="border-t border-border">
              <td className="px-3 py-3">{row.slot}</td><td className="px-3 py-3 font-mono">{row.code}</td>
              <td className="px-3 py-3">₹{(row.amount_paise / 100).toFixed(2)}</td>
              <td className="px-3 py-3">{row.duration_min || "—"}{row.duration_min ? " min" : ""}</td>
              <td className="px-3 py-3"><Pill t={["paid", "active", "completed"].includes(status) ? "free" : status === "pending" ? "reserved" : "muted"}>{status}</Pill></td>
              <td className="whitespace-nowrap px-3 py-3">{new Date(row.created_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</td>
            </tr>;
          })}</tbody>
        </table></div>}
    </Panel>
  </div>;
}

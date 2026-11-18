import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { ExternalLink, IndianRupee, LogIn, Search, RefreshCw, Car } from "lucide-react";
import { useSessions, type ParkingSessionRow } from "@/lib/parking/sessions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Panel, Pill, StatCard } from "./kit";

export function CollectedTotal() {
  const { total, loading, error } = useSessions();
  return (
    <StatCard
      label="Today's collected · IST"
      value={loading ? "…" : !error ? `₹${total}` : "—"}
      icon={<IndianRupee className="size-4" />}
      t="free"
      sub="Verified Razorpay payments"
    />
  );
}

export function SessionPanel({ entry = false }: { entry?: boolean }) {
  const { rows, loading, error, refresh } = useSessions();
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");

  const filtered = rows.filter((row) => {
    const matchesFilter = filter === "all" || row.status === filter;
    const searchTarget = `${row.slot} ${row.code} ${row.vehicle_no || ""} ${row.amount_inr}`.toLowerCase();
    const matchesSearch = searchTarget.includes(search.toLowerCase());
    return matchesFilter && matchesSearch;
  });

  const pendingSession = rows.find((row) => row.status === "pending");
  const payUrl = pendingSession ? `https://scrolltide-dashboard.lovable.app/p/${pendingSession.code}` : null;

  return (
    <div className="space-y-5">
      {entry && (
        <Panel title="Active Entry Session">
          <div className="flex flex-wrap items-center gap-6">
            {pendingSession && payUrl ? (
              <>
                <div className="rounded-xl bg-white p-3 shadow-md">
                  <QRCodeSVG value={payUrl} size={150} />
                </div>
                <div className="space-y-2.5">
                  <div className="flex items-center gap-2">
                    <Pill t="reserved">Waiting for payment</Pill>
                    <span className="font-mono text-xs px-2 py-0.5 rounded bg-surface-2 font-bold">
                      {pendingSession.code}
                    </span>
                  </div>
                  <p className="text-2xl font-bold">
                    Slot {pendingSession.slot}
                  </p>
                  <p className="text-xs text-muted-foreground font-mono">
                    Pay URL: {payUrl}
                  </p>
                  <Button asChild variant="outline" size="sm" className="mt-1">
                    <a href={payUrl} target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="size-3.5 mr-1" />
                      Open Driver Pay Page
                    </a>
                  </Button>
                </div>
              </>
            ) : (
              <p className="py-6 text-sm text-muted-foreground">
                No active entry session waiting for payment. Car stopping at entry will generate a QR.
              </p>
            )}
            <p className="w-full text-xs text-muted-foreground border-t border-border pt-2">
              Entry authorization requires verified Razorpay payment. The entry barrier opens automatically upon payment confirmation.
            </p>
          </div>
        </Panel>
      )}

      <Panel title="Parking Sessions">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {["all", "pending", "paid", "active", "completed", "expired", "cancelled"].map((v) => (
            <Button
              key={v}
              size="sm"
              variant={filter === v ? "default" : "outline"}
              onClick={() => setFilter(v)}
              className="text-xs h-8 capitalize"
            >
              {v}
            </Button>
          ))}
          <div className="sm:ml-auto flex items-center gap-2 w-full sm:w-auto">
            <Input
              aria-label="Search sessions"
              placeholder="Slot, code, vehicle..."
              className="h-8 text-xs sm:w-56"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Button size="sm" variant="ghost" className="h-8 px-2" onClick={() => refresh()}>
              <RefreshCw className="size-3.5" />
            </Button>
          </div>
        </div>

        {error ? (
          <p className="text-xs text-destructive py-2">{error}</p>
        ) : loading ? (
          <p className="text-xs text-muted-foreground py-4">Loading sessions…</p>
        ) : !filtered.length ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No parking sessions found.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-left text-xs">
              <thead className="bg-surface-2 text-muted-foreground border-b border-border">
                <tr>
                  {["Code", "Slot", "Vehicle", "Duration", "Amount", "Status", "Created (IST)", "Paid (IST)"].map((h) => (
                    <th key={h} className="px-3 py-2.5 font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border font-mono">
                {filtered.map((row) => {
                  const statusPillTone =
                    row.status === "paid" || row.status === "active" || row.status === "completed"
                      ? "free"
                      : row.status === "pending"
                      ? "reserved"
                      : "error";

                  return (
                    <tr key={row.id} className="hover:bg-surface-2/50 transition-colors">
                      <td className="px-3 py-2.5 font-bold text-foreground">{row.code}</td>
                      <td className="px-3 py-2.5">Slot {row.slot}</td>
                      <td className="px-3 py-2.5 uppercase">{row.vehicle_no || "—"}</td>
                      <td className="px-3 py-2.5">{row.duration_min ? `${row.duration_min} min` : "—"}</td>
                      <td className="px-3 py-2.5 font-semibold text-emerald-400">
                        {row.amount_inr ? `₹${row.amount_inr}` : "—"}
                      </td>
                      <td className="px-3 py-2.5">
                        <Pill t={statusPillTone}>{row.status}</Pill>
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-muted-foreground">
                        {new Date(row.created_at).toLocaleTimeString("en-IN", {
                          timeZone: "Asia/Kolkata",
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        })}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-muted-foreground">
                        {row.paid_at
                          ? new Date(row.paid_at).toLocaleTimeString("en-IN", {
                              timeZone: "Asia/Kolkata",
                              hour: "2-digit",
                              minute: "2-digit",
                              second: "2-digit",
                            })
                          : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

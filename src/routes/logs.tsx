import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Search } from "lucide-react";
import { useParking } from "@/lib/parking/store";
import { Input } from "@/components/ui/input";
import { LogList, Panel } from "@/components/dash/kit";
import { cn } from "@/lib/utils";
import { SessionPanel } from "@/components/dash/SessionPanel";

export const Route = createFileRoute("/logs")({
  head: () => ({
    meta: [
      { title: "Activity Logs — ParkSense" },
      { name: "description", content: "Filterable live event log for entry, exit, slots and sensors." },
      { property: "og:title", content: "Activity Logs — ParkSense" },
      { property: "og:description", content: "Filterable live event log for entry, exit, slots and sensors." },
    ],
  }),
  component: Logs,
});

const FILTERS = [
  { k: "all", label: "All events" }, { k: "entry", label: "Entry" }, { k: "exit", label: "Exit" },
  { k: "slot", label: "Parking slots" }, { k: "sensor", label: "Sensors" }, { k: "warn", label: "Warnings" },
] as const;

function Logs() {
  const { state: s, mode } = useParking();
  const [f, setF] = useState<(typeof FILTERS)[number]["k"]>("all");
  const [q, setQ] = useState("");
  if (mode === "live") return <SessionPanel />;
  const logs = s.logs.filter((l) =>
    (f === "all" || (f === "warn" ? l.severity === "warning" || l.severity === "error" : l.category === f)) &&
    (!q || l.message.toLowerCase().includes(q.toLowerCase())));
  return (
    <Panel>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {FILTERS.map((x) => (
          <button key={x.k} onClick={() => setF(x.k)} className={cn("rounded-full border px-3 py-1 text-xs transition-colors", f === x.k ? "border-primary bg-primary/15 text-primary" : "border-border text-muted-foreground hover:text-foreground")}>{x.label}</button>
        ))}
        <div className="relative ml-auto w-full sm:w-64">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search events" className="pl-8" />
        </div>
      </div>
      <LogList logs={logs} empty="No events match this filter" />
    </Panel>
  );
}

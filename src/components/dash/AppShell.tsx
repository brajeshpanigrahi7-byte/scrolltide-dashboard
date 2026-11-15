import { Link, useRouterState } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import {
  Activity, BarChart3, Bell, ChevronsLeft, DoorOpen, GitBranch, LayoutDashboard, LogIn, Menu, ParkingSquare, Radar, ScrollText, Settings, X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useParking } from "@/lib/parking/store";
import { Dot, Pill } from "./kit";

const NAV = [
  { to: "/", label: "Overview", icon: LayoutDashboard },
  { to: "/parking", label: "Live Parking", icon: ParkingSquare },
  { to: "/entry", label: "Entry Management", icon: LogIn },
  { to: "/exit", label: "Exit Management", icon: DoorOpen },
  { to: "/sensors", label: "Sensor Monitoring", icon: Radar },
  { to: "/workflow", label: "Workflow", icon: GitBranch },
  { to: "/analytics", label: "Analytics & Reports", icon: BarChart3 },
  { to: "/logs", label: "Activity Logs", icon: ScrollText },
  { to: "/settings", label: "System Settings", icon: Settings },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const path = useRouterState({ select: (r) => r.location.pathname });
  useEffect(() => setMobileOpen(false), [path]);

  if (path.startsWith("/p/")) {
    return <div className="min-h-screen bg-background text-foreground">{children}</div>;
  }

  const nav = (
    <nav className="flex flex-1 flex-col gap-1 p-3">
      {NAV.map(({ to, label, icon: Icon }) => {
        const active = path === to;
        return (
          <Link key={to} to={to} title={collapsed ? label : undefined}
            className={cn("group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors",
              active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground")}>
            <Icon className={cn("size-4 shrink-0", active && "text-primary")} />
            {!collapsed && <span className="truncate">{label}</span>}
            {active && !collapsed && <span className="ml-auto h-4 w-0.5 rounded-full bg-primary" />}
          </Link>
        );
      })}
    </nav>
  );

  const brand = (
    <div className="flex h-16 items-center gap-2.5 border-b border-sidebar-border px-4">
      <div className="glow-primary grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground"><ParkingSquare className="size-5" /></div>
      {!collapsed && <div className="leading-tight"><p className="text-sm font-bold">ParkSense</p><p className="font-mono text-[10px] text-muted-foreground">ESP32 · 5 SLOTS</p></div>}
    </div>
  );

  return (
    <div className="flex min-h-screen">
      <aside className={cn("sticky top-0 hidden h-screen shrink-0 flex-col border-r border-sidebar-border bg-sidebar transition-[width] duration-300 lg:flex", collapsed ? "w-[68px]" : "w-60")}>
        {brand}
        {nav}
        <button onClick={() => setCollapsed((c) => !c)} className="m-3 flex items-center justify-center gap-2 rounded-lg border border-sidebar-border py-2 text-xs text-muted-foreground hover:text-foreground" aria-label="Toggle sidebar">
          <ChevronsLeft className={cn("size-4 transition-transform", collapsed && "rotate-180")} />{!collapsed && "Collapse"}
        </button>
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <div className="absolute inset-0 bg-background/70 backdrop-blur-sm" onClick={() => setMobileOpen(false)} />
          <aside className="relative flex w-64 flex-col bg-sidebar animate-in slide-in-from-left">
            {brand}
            <button className="absolute right-3 top-5" onClick={() => setMobileOpen(false)} aria-label="Close menu"><X className="size-5" /></button>
            {nav}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onMenu={() => setMobileOpen(true)} title={NAV.find((n) => n.to === path)?.label ?? "Dashboard"} />
        <main className="flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}

function TopBar({ onMenu, title }: { onMenu: () => void; title: string }) {
  const { state, mode, liveError } = useParking();
  const [clock, setClock] = useState<Date | null>(null);
  useEffect(() => { setClock(new Date()); const t = setInterval(() => setClock(new Date()), 1000); return () => clearInterval(t); }, []);
  const alerts = state.logs.filter((l) => l.severity === "error" || l.severity === "warning").slice(0, 5);
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 flex h-16 items-center gap-3 border-b border-border bg-background/85 px-4 backdrop-blur md:px-6">
      <button className="lg:hidden" onClick={onMenu} aria-label="Open menu"><Menu className="size-5" /></button>
      <h1 className="truncate text-lg font-semibold">{title}</h1>
      <div className="ml-auto flex items-center gap-2 md:gap-4">
        {mode === "demo"
          ? <span title="No Firebase database configured — showing a simulation of the firmware"><Pill t="warning" pulse>Demo mode</Pill></span>
          : <span title={liveError ?? "Reading hardware state"}><Pill t={state.online && !liveError ? "primary" : "warning"} pulse={state.online && !liveError}>{state.online && !liveError ? "Live hardware" : "Device offline"}</Pill></span>}
        <span className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex" title="ESP32 heartbeat">
          <Dot t={state.online ? "free" : "error"} pulse={state.online} /> ESP32 {state.online ? "online" : "offline"}
        </span>
        <span className="hidden font-mono text-xs text-muted-foreground md:block">{clock ? clock.toLocaleString([], { dateStyle: "medium", timeStyle: "medium" }) : ""}</span>
        <div className="relative">
          <button onClick={() => setOpen((o) => !o)} className="relative rounded-lg p-2 hover:bg-accent" aria-label="Notifications">
            <Bell className="size-4" />
            {alerts.length > 0 && <span className="absolute right-1 top-1 size-2 rounded-full bg-warning" />}
          </button>
          {open && (
            <div className="panel absolute right-0 top-11 w-80 p-3 shadow-2xl animate-in fade-in zoom-in-95">
              <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground"><Activity className="size-3.5" />Alerts</p>
              {alerts.length ? alerts.map((a) => <p key={a.id} className="border-t border-border py-2 text-sm">{a.message}</p>) : <p className="py-4 text-center text-sm text-muted-foreground">All clear</p>}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

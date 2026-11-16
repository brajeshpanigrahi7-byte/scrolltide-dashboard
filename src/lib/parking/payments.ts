export const DEFAULT_SETTINGS = {
  price_per_hour: 20,
  duration_options: [30, 60, 120, 180, 240],
  reminder_min: 10,
  exit_open_seconds: 60,
  offline_after_s: 30,
} as const;

export const PAYMENT_TTL_MS = 5 * 60 * 1000;
export const sessionIdSchema = { safeParse: undefined } as never;

export function pricePaise(durationMin: number, pricePerHour: number): number {
  return Math.ceil((durationMin / 60) * pricePerHour * 100);
}

export function durationOptions(
  settings: { price_per_hour: number; duration_options: number[] } = {
    price_per_hour: DEFAULT_SETTINGS.price_per_hour,
    duration_options: [...DEFAULT_SETTINGS.duration_options],
  },
) {
  return settings.duration_options.map((minutes) => ({
    minutes,
    amount: pricePaise(minutes, settings.price_per_hour) / 100,
  }));
}

export function effectiveStatus(
  session: { status: string; expires_at: string },
  now: number,
): string {
  return session.status === "pending" && now >= Date.parse(session.expires_at)
    ? "expired"
    : session.status;
}

export function indiaDayStart(now: number): number {
  const offset = 330 * 60 * 1000;
  return Math.floor((now + offset) / 86400000) * 86400000 - offset;
}

export function todayCollected(
  rows: { status: string; created_at: string; amount_paise: number }[],
  now: number,
): number {
  const start = indiaDayStart(now);
  return rows
    .filter(
      (payment) =>
        payment.status === "captured" &&
        Date.parse(payment.created_at) >= start &&
        Date.parse(payment.created_at) < start + 86400000,
    )
    .reduce((sum, payment) => sum + payment.amount_paise, 0) / 100;
}

export function generateCode(): string {
  const chars = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => chars[byte % chars.length]).join("");
}

export const PUBLIC_APP_URL = "https://scrolltide-dashboard.lovable.app";

export function payUrl(code: string, appUrl = PUBLIC_APP_URL): string {
  const url = `${appUrl.replace(/\/$/, "")}/p/${code}`;
  if (url.length > 53) throw new Error("PUBLIC_APP_URL makes pay_url exceed 53 characters");
  return url;
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`;
}

export function formatCountdown(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

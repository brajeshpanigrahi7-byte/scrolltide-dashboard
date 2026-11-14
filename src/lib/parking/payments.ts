import { z } from "zod";

export const createSessionSchema = z.object({
  slot: z.number().int().min(1).max(5),
  amount_inr: z.number().int().min(20).max(200).refine((v) => v % 20 === 0, "Use ₹20 increments"),
});
export const sessionIdSchema = z.string().uuid();
export const PAYMENT_TTL_MS = 15 * 60 * 1000;
export const durationOptions = Array.from({ length: 10 }, (_, i) => ({ minutes: (i + 1) * 30, amount: (i + 1) * 20 }));
export function effectiveStatus(s: { status: string; created_at: string }, now: number) {
  return s.status === "pending" && now >= Date.parse(s.created_at) + PAYMENT_TTL_MS ? "expired" : s.status;
}
export function indiaDayStart(now: number) {
  const offset = 330 * 60 * 1000;
  return Math.floor((now + offset) / 86400000) * 86400000 - offset;
}

export function todayCollected(rows: { status: string; paid_at: string | null; amount_inr: number }[], now: number) {
  const start = indiaDayStart(now);
  return rows.filter((s) => (s.status === "paid" || s.status === "used") && s.paid_at && Date.parse(s.paid_at) >= start && Date.parse(s.paid_at) < start + 86400000).reduce((sum, s) => sum + s.amount_inr, 0);
}
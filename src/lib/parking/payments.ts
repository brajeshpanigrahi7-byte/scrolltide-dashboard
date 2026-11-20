import { z } from "zod";

export const createSessionSchema = z.object({
  slot: z.number().int().min(1).max(5),
  amount_inr: z
    .number()
    .int()
    .min(20)
    .max(200)
    .refine((v) => v % 20 === 0, "Use ₹20 increments"),
});
export const sessionIdSchema = z.string().uuid();
export const PAYMENT_TTL_MS = 10 * 60 * 1000;
export const RATE_PER_30MIN = 20;
export const MAX_DURATION_MIN = 300; // 5 hours

export const durationOptions = Array.from({ length: 10 }, (_, i) => ({
  minutes: (i + 1) * 30,
  amount: (i + 1) * RATE_PER_30MIN,
}));

export type SessionStatus =
  "awaiting_payment" | "paid" | "active" | "completed" | "expired" | "cancelled";

export function effectiveStatus(s: { status: string; created_at: string }, now: number): string {
  const isPending = s.status === "pending" || s.status === "awaiting_payment";
  return isPending && now >= Date.parse(s.created_at) + 15 * 60 * 1000 ? "expired" : s.status;
}

export function indiaDayStart(now: number) {
  const offset = 330 * 60 * 1000;
  return Math.floor((now + offset) / 86400000) * 86400000 - offset;
}

export function todayCollected(
  rows: { status: string; paid_at: string | null; amount_inr: number }[],
  now: number,
) {
  const start = indiaDayStart(now);
  return rows
    .filter(
      (s) =>
        (s.status === "paid" ||
          s.status === "used" ||
          s.status === "active" ||
          s.status === "completed") &&
        s.paid_at &&
        Date.parse(s.paid_at) >= start &&
        Date.parse(s.paid_at) < start + 86400000,
    )
    .reduce((sum, s) => sum + s.amount_inr, 0);
}

export const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // 32 characters: strictly forbids 0, 1, I, and O

/**
 * Generate a cryptographically secure random session code.
 * Picks random characters exclusively from "23456789ABCDEFGHJKLMNPQRSTUVWXYZ" (32 characters, no 0, 1, I, or O).
 * Default length is 6 to satisfy the database check constraint:
 * CHECK ((code ~ '^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$'::text))
 */
export function generateCode(length = 6): string {
  const CHARS = CODE_ALPHABET;
  let code = "";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < length; i++) {
    code += CHARS[bytes[i]! % CHARS.length];
  }
  return code;
}

export const PAY_URL_BASE = "https://scrolltide-dashboard.lovable.app/p/";

/** Build a pay URL. */
export function payUrl(code: string): string {
  return `${PAY_URL_BASE}${code}`;
}

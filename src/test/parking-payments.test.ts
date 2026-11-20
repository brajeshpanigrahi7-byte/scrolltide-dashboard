import { describe, expect, it } from "vitest";
import {
  createSessionSchema,
  durationOptions,
  effectiveStatus,
  todayCollected,
} from "@/lib/parking/payments";

describe("parking payment rules", () => {
  it("charges ₹20 per 30 minutes up to five hours", () => {
    expect(durationOptions).toEqual(
      Array.from({ length: 10 }, (_, i) => ({ minutes: (i + 1) * 30, amount: (i + 1) * 20 })),
    );
    for (const amount_inr of [0, 19, 21, 201, 220])
      expect(createSessionSchema.safeParse({ slot: 1, amount_inr }).success).toBe(false);
    expect(createSessionSchema.parse({ slot: 5, amount_inr: 200 })).toEqual({
      slot: 5,
      amount_inr: 200,
    });
  });
  it("accepts only integer slots one through five", () => {
    for (const slot of [0, 6, 1.5])
      expect(createSessionSchema.safeParse({ slot, amount_inr: 20 }).success).toBe(false);
  });
  it("expires pending sessions after exactly fifteen minutes but never expires paid or used sessions", () => {
    const created_at = "2026-11-15T04:00:00Z";
    const start = Date.parse(created_at);
    expect(effectiveStatus({ status: "pending", created_at }, start + 899999)).toBe("pending");
    expect(effectiveStatus({ status: "pending", created_at }, start + 900000)).toBe("expired");
    for (const status of ["paid", "used", "expired"])
      expect(effectiveStatus({ status, created_at }, start + 900000)).toBe(status);
  });
  it("counts only verified paid and used payments within today's India calendar day", () => {
    const rows = [
      { status: "paid", amount_inr: 20, paid_at: "2026-11-14T18:30:00Z" },
      { status: "used", amount_inr: 200, paid_at: "2026-11-15T18:29:59Z" },
      { status: "paid", amount_inr: 40, paid_at: "2026-11-14T18:29:59Z" },
      { status: "paid", amount_inr: 60, paid_at: "2026-11-15T18:30:00Z" },
      { status: "pending", amount_inr: 80, paid_at: "2026-11-15T05:00:00Z" },
      { status: "expired", amount_inr: 100, paid_at: "2026-11-15T05:00:00Z" },
      { status: "paid", amount_inr: 120, paid_at: null },
    ];
    expect(todayCollected(rows, Date.parse("2026-11-15T05:03:00Z"))).toBe(220);
  });
});

import { describe, expect, it } from "vitest";
import { durationOptions, effectiveStatus, payUrl, pricePaise, todayCollected } from "@/lib/parking/payments";

describe("parking payment rules", () => {
  it("uses the latest ₹20/hour tariff and duration choices", () => {
    expect(durationOptions()).toEqual([
      { minutes: 30, amount: 10 }, { minutes: 60, amount: 20 }, { minutes: 120, amount: 40 },
      { minutes: 180, amount: 60 }, { minutes: 240, amount: 80 },
    ]);
    expect(pricePaise(30, 20)).toBe(1000);
    expect(pricePaise(240, 20)).toBe(8000);
  });
  it("expires only pending sessions after five minutes", () => {
    const expires_at = "2026-11-15T04:05:00Z";
    const end = Date.parse(expires_at);
    expect(effectiveStatus({ status: "pending", expires_at }, end - 1)).toBe("pending");
    expect(effectiveStatus({ status: "pending", expires_at }, end)).toBe("expired");
    for (const status of ["paid", "active", "completed", "cancelled"]) {
      expect(effectiveStatus({ status, expires_at }, end)).toBe(status);
    }
  });
  it("counts captured payments in today's India calendar day", () => {
    const rows = [
      { status: "captured", amount_paise: 2000, created_at: "2026-11-14T18:30:00Z" },
      { status: "captured", amount_paise: 1000, created_at: "2026-11-15T18:29:59Z" },
      { status: "created", amount_paise: 4000, created_at: "2026-11-15T05:00:00Z" },
      { status: "needs_refund", amount_paise: 6000, created_at: "2026-11-15T05:00:00Z" },
    ];
    expect(todayCollected(rows, Date.parse("2026-11-15T05:03:00Z"))).toBe(30);
  });
  it("keeps device QR URLs within 53 characters", () => {
    expect(payUrl("AB23CD")).toBe("https://scrolltide-dashboard.lovable.app/p/AB23CD");
    expect(payUrl("AB23CD").length).toBeLessThanOrEqual(53);
    expect(() => payUrl("AB23CD", "https://a-much-longer-parking-domain.example.com")).toThrow();
  });
});

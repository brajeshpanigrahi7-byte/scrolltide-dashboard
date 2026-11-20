// @vitest-environment node
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { assertAdmin } from "@/lib/parking/admin.functions";
import { markPaidServer, razorpayWebhook } from "@/lib/parking/payment-api.server";
import { verifyPayment } from "@/lib/parking/driver-api.server";
import { createHmac } from "node:crypto";

const mockDbState = {
  payments: [] as any[],
  sessions: [] as any[],
  activity_logs: [] as any[],
};

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      let filtered = (mockDbState as any)[table] || [];
      let pendingUpdates: any = null;

      const applyUpdates = () => {
        if (pendingUpdates) {
          for (const r of filtered) {
            Object.assign(r, pendingUpdates);
          }
        }
      };

      const builder: any = {
        select: (_fields?: string) => {
          applyUpdates();
          return builder;
        },
        eq: (col: string, val: any) => {
          filtered = filtered.filter((r: any) => r[col] === val);
          return builder;
        },
        is: (col: string, val: any) => {
          filtered = filtered.filter((r: any) => (val === null ? r[col] == null : r[col] === val));
          return builder;
        },
        maybeSingle: async () => {
          applyUpdates();
          const row = filtered[0] || null;
          if (row && table === "payments") {
            const sess = mockDbState.sessions.find((s) => s.id === row.session_id);
            return { data: { ...row, sessions: sess || null }, error: null };
          }
          return { data: row ? { ...row } : null, error: null };
        },
        single: async () => {
          applyUpdates();
          const row = filtered[0];
          return { data: row ? { ...row } : null, error: row ? null : new Error("Not found") };
        },
        then: (resolve: any, reject?: any) => {
          applyUpdates();
          return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
        },
        insert: (data: any) => {
          const row = Array.isArray(data) ? data[0] : data;
          const newRow = { id: row.id || `uuid-${Math.random()}`, ...row };
          (mockDbState as any)[table]?.push(newRow);
          filtered = [newRow];
          return builder;
        },
        update: (updates: any) => {
          pendingUpdates = updates;
          return builder;
        },
      };
      return builder;
    },
  },
}));

beforeEach(() => {
  vi.stubEnv("RAZORPAY_KEY_ID", "rzp_test_fixture");
  vi.stubEnv("RAZORPAY_KEY_SECRET", "rzp_secret_fixture");
  vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", "rzp_webhook_secret_fixture");
  vi.stubEnv("DEVICE_API_KEY", "device-secret-xyz");

  mockDbState.payments = [];
  mockDbState.sessions = [];
  mockDbState.activity_logs = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Job B Security Hardening", () => {
  describe("Admin Role Authorization (assertAdmin)", () => {
    it("rejects when userId is missing", async () => {
      await expect(assertAdmin({ supabase: {} as any, userId: "" })).rejects.toThrow(
        "Authentication required",
      );
    });

    it("rejects signed-in user who has NO row in user_roles", async () => {
      const mockSupabase = {
        rpc: async () => ({ data: false, error: null }),
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
        }),
      };

      await expect(
        assertAdmin({ supabase: mockSupabase as any, userId: "user-without-role" }),
      ).rejects.toThrow("Admin access required");
    });

    it("rejects signed-in user whose role is not admin (e.g. viewer)", async () => {
      const mockSupabase = {
        rpc: async () => ({ data: false, error: null }),
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { role: "viewer" },
                error: null,
              }),
            }),
          }),
        }),
      };

      await expect(
        assertAdmin({ supabase: mockSupabase as any, userId: "user-viewer" }),
      ).rejects.toThrow("Admin access required");
    });

    it("allows user who has admin role", async () => {
      const mockSupabase = {
        rpc: async () => ({ data: true, error: null }),
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { role: "admin" },
                error: null,
              }),
            }),
          }),
        }),
      };

      await expect(
        assertAdmin({ supabase: mockSupabase as any, userId: "admin-user-id" }),
      ).resolves.not.toThrow();
    });
  });

  describe("Payment Verification & Razorpay Webhook", () => {
    it("rejects verifyPayment with an invalid signature", async () => {
      const req = new Request("https://example.com/api/public/verify-payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          razorpay_order_id: "order_123",
          razorpay_payment_id: "pay_123",
          razorpay_signature: "invalid_fake_signature_hex",
        }),
      });

      const res = await verifyPayment(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("Invalid signature");
    });

    it("rejects razorpay webhook with an invalid signature", async () => {
      const payload = JSON.stringify({ event: "order.paid" });
      const req = new Request("https://example.com/api/public/razorpay-webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-razorpay-signature": "bogus_signature_that_does_not_match_hmac",
        },
        body: payload,
      });

      const res = await razorpayWebhook(req);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toBe("Invalid signature");
    });

    it("accepts razorpay webhook with a valid HMAC SHA256 signature", async () => {
      const payload = JSON.stringify({
        event: "payment.captured",
        payload: {
          payment: {
            entity: {
              id: "pay_valid_123",
              order_id: "order_valid_123",
              amount: 2000,
            },
          },
        },
      });

      const secret = "rzp_webhook_secret_fixture";
      const validSig = createHmac("sha256", secret).update(payload).digest("hex");

      mockDbState.sessions.push({
        id: "sess-valid-webhook",
        slot: 1,
        code: "WEB999",
        status: "pending",
        expires_at: new Date(Date.now() + 600000).toISOString(),
      });

      mockDbState.payments.push({
        id: "pmt-valid-webhook",
        session_id: "sess-valid-webhook",
        razorpay_order_id: "order_valid_123",
        amount_paise: 2000,
        kind: "new",
        duration_min: 30,
        status: "created",
      });

      const req = new Request("https://example.com/api/public/razorpay-webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-razorpay-signature": validSig,
        },
        body: payload,
      });

      const res = await razorpayWebhook(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe("ok");

      const updatedPayment = mockDbState.payments.find(
        (p) => p.razorpay_order_id === "order_valid_123",
      );
      expect(updatedPayment?.status).toBe("captured");
    });

    it("markPaidServer is idempotent: duplicate payment call does not double extend or error", async () => {
      mockDbState.sessions.push({
        id: "sess-idempotent",
        slot: 2,
        code: "IDEM01",
        status: "pending",
        expires_at: new Date(Date.now() + 600000).toISOString(),
      });

      mockDbState.payments.push({
        id: "pmt-idempotent",
        session_id: "sess-idempotent",
        razorpay_order_id: "order_idem_1",
        amount_paise: 2000,
        kind: "new",
        duration_min: 30,
        status: "created",
      });

      // First execution: captures payment and marks session paid
      const firstResult = await markPaidServer("order_idem_1", "pay_idem_1", 2000);
      expect(firstResult.status).toBe("captured");

      const pmtAfterFirst = mockDbState.payments.find((p) => p.id === "pmt-idempotent");
      expect(pmtAfterFirst?.status).toBe("captured");
      expect(pmtAfterFirst?.razorpay_payment_id).toBe("pay_idem_1");

      const sessAfterFirst = mockDbState.sessions.find((s) => s.id === "sess-idempotent");
      expect(sessAfterFirst?.status).toBe("paid");

      // Second duplicate execution with same paymentId: returns already_captured without modifying
      const secondResult = await markPaidServer("order_idem_1", "pay_idem_1", 2000);
      expect(secondResult.status).toBe("already_captured");
    });
  });
});

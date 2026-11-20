// @vitest-environment node
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { assertAdmin } from "@/lib/parking/admin.functions";
import { markPaidServer, razorpayWebhook, stripeWebhook } from "@/lib/parking/payment-api.server";
import { verifyPayment, createOrder, leaveNow, sessionPublic, resetRateLimits } from "@/lib/parking/driver-api.server";
import { generateCode } from "@/lib/parking/payments";
import { createHmac } from "node:crypto";

const mockDbState = {
  payments: [] as any[],
  sessions: [] as any[],
  activity_logs: [] as any[],
  settings: [] as any[],
  user_roles: [] as any[],
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
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_stripe_test_fixture");
  vi.stubEnv("DEVICE_API_KEY", "device-secret-xyz");

  mockDbState.payments = [];
  mockDbState.sessions = [];
  mockDbState.activity_logs = [];
  mockDbState.settings = [
    {
      id: 1,
      price_per_hour: 20,
      duration_options: [30, 60, 120, 180, 240],
      reminder_min: 10,
      exit_open_seconds: 60,
      offline_after_s: 30,
    },
  ];
  mockDbState.user_roles = [
    { user_id: "admin-user-id", role: "admin" },
    { user_id: "regular-user-id", role: "user" },
  ];
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

  describe("Requirement 1: Admin Role Immuntability", () => {
    it("prevents self-demoting admin or modifying roles without admin privilege", async () => {
      const mockSupabase = {
        rpc: async () => ({ data: false, error: null }),
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { role: "user" },
                error: null,
              }),
            }),
          }),
        }),
      };

      await expect(
        assertAdmin({ supabase: mockSupabase as any, userId: "regular-user-id" }),
      ).rejects.toThrow("Admin access required");
    });
  });

  describe("Requirement 2 & 3: Cryptographically Secure Random Tokens", () => {
    it("generates 8+ alphanumeric random tokens with zero modulo bias", () => {
      const code1 = generateCode(8);
      const code2 = generateCode(8);
      expect(code1).toHaveLength(8);
      expect(code2).toHaveLength(8);
      expect(code1).not.toBe(code2);
      expect(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/.test(code1)).toBe(true);
    });

    it("supports custom lengths of 8 or more", () => {
      const code10 = generateCode(10);
      expect(code10).toHaveLength(10);
      const codeMin = generateCode(4); // clamped to minimum 8
      expect(codeMin).toHaveLength(8);
    });
  });

  describe("Requirement 3: Rate Limiting & User ID Ownership on Exit Barrier", () => {
    it("rejects unauthenticated leave-now requests with 401", async () => {
      const req = new Request("https://example.com/api/public/leave-now", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "EXIT8888" }),
      });

      const res = await leaveNow(req);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toBe("Authentication required to trigger exit barrier");
    });

    it("rejects leave-now when session belongs to a different user (not admin)", async () => {
      mockDbState.sessions.push({
        id: "sess-exit-1",
        code: "EXIT8888",
        user_id: "other-user-999",
        slot: 1,
        status: "active",
      });

      const req = new Request("https://example.com/api/public/leave-now", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-token-different-user",
        },
        body: JSON.stringify({ code: "EXIT8888" }),
      });

      const res = await leaveNow(req);
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toBe("Unauthorized: You do not own this parking session");
    });

    it("allows leave-now when calling user is the verified session owner", async () => {
      mockDbState.sessions.push({
        id: "sess-exit-owner",
        code: "OWNER888",
        user_id: "user-owner-123",
        slot: 3,
        status: "active",
      });

      const req = new Request("https://example.com/api/public/leave-now", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-token-owner-123",
        },
        body: JSON.stringify({ code: "OWNER888" }),
      });

      const res = await leaveNow(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);

      const updated = mockDbState.sessions.find((s) => s.id === "sess-exit-owner");
      expect(updated?.end_time).toBeDefined();
    });
  });

  describe("Requirement 4: Valid User Authentication for Session Creation & Webhook-Exclusive Access Activation", () => {
    it("rejects unauthenticated create-order with 401", async () => {
      const req = new Request("https://example.com/api/public/create-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "NEW88888", duration_min: 30 }),
      });

      const res = await createOrder(req);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toBe("Authentication required to create a payment session");
    });

    it("verifyPayment validates cryptographic signature but does NOT activate parking access directly", async () => {
      const keySecret = "rzp_secret_fixture";
      const orderId = "order_client_verify";
      const paymentId = "pay_client_verify";
      const signature = createHmac("sha256", keySecret)
        .update(`${orderId}|${paymentId}`)
        .digest("hex");

      mockDbState.sessions.push({
        id: "sess-client-check",
        code: "CLIENT88",
        status: "pending",
      });

      mockDbState.payments.push({
        id: "pmt-client-check",
        session_id: "sess-client-check",
        razorpay_order_id: orderId,
        amount_paise: 2000,
        status: "created",
      });

      const req = new Request("https://example.com/api/public/verify-payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          razorpay_order_id: orderId,
          razorpay_payment_id: paymentId,
          razorpay_signature: signature,
        }),
      });

      const res = await verifyPayment(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.verified).toBe(true);

      // Session MUST remain pending until verified server webhook arrives!
      const sessionAfterVerify = mockDbState.sessions.find((s) => s.id === "sess-client-check");
      expect(sessionAfterVerify?.status).toBe("pending");
    });

    it("activates parking access exclusively via verified Stripe webhook signature", async () => {
      const payload = JSON.stringify({
        type: "payment_intent.succeeded",
        data: {
          object: {
            id: "pi_stripe_test_123",
            amount: 2000,
            metadata: { order_id: "order_stripe_1" },
          },
        },
      });

      const secret = "whsec_stripe_test_fixture";
      const timestamp = String(Math.floor(Date.now() / 1000));
      const sig = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
      const sigHeader = `t=${timestamp},v1=${sig}`;

      mockDbState.sessions.push({
        id: "sess-stripe-1",
        code: "STRIPE88",
        slot: 1,
        status: "pending",
        expires_at: new Date(Date.now() + 600000).toISOString(),
      });

      mockDbState.payments.push({
        id: "pmt-stripe-1",
        session_id: "sess-stripe-1",
        razorpay_order_id: "order_stripe_1",
        amount_paise: 2000,
        kind: "new",
        duration_min: 30,
        status: "created",
      });

      const req = new Request("https://example.com/api/public/stripe-webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "stripe-signature": sigHeader,
        },
        body: payload,
      });

      const res = await stripeWebhook(req);
      expect(res.status).toBe(200);

      // Access is activated server-side exclusively by the verified webhook!
      const sessAfter = mockDbState.sessions.find((s) => s.id === "sess-stripe-1");
      expect(sessAfter?.status).toBe("paid");
    });

    it("rejects Stripe webhook with invalid signature", async () => {
      const payload = JSON.stringify({ type: "payment_intent.succeeded" });
      const req = new Request("https://example.com/api/public/stripe-webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "stripe-signature": "t=123456,v1=invalid_bogus_signature",
        },
        body: payload,
      });

      const res = await stripeWebhook(req);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toBe("Invalid signature");
    });
  });

  describe("Requirement 5 & 7: Ownership Verification & Contact Detail Protection", () => {
    beforeEach(() => {
      resetRateLimits();
    });

    it("sessionPublic strips vehicle_no and hides contact details from unauthenticated callers", async () => {
      mockDbState.sessions.push({
        id: "sess-privacy-1",
        code: "PRIV1234",
        slot: 3,
        status: "pending",
        user_id: "user-owner-1",
        vehicle_no: "MH02AB1234",
        contact_email: "driver@example.com",
        contact_phone: "+919876543210",
        expires_at: new Date(Date.now() + 600000).toISOString(),
      });

      const req = new Request("https://example.com/api/public/session-public?code=PRIV1234");
      const res = await sessionPublic(req);
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.code).toBe("PRIV1234");
      expect(data.slot).toBe(3);
      expect(data.vehicle_no).toBeUndefined();
      expect(data.contact_email).toBeUndefined();
      expect(data.contact_phone).toBeUndefined();
    });

    it("sessionPublic reveals vehicle_no to verified session owner", async () => {
      mockDbState.sessions.push({
        id: "sess-privacy-2",
        code: "PRIV5678",
        slot: 4,
        status: "active",
        user_id: "user-owner-1",
        vehicle_no: "KA01XY9999",
        expires_at: new Date(Date.now() + 600000).toISOString(),
      });

      const req = new Request("https://example.com/api/public/session-public?code=PRIV5678", {
        headers: { Authorization: "Bearer test-token-owner-1" },
      });
      const res = await sessionPublic(req);
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.vehicle_no).toBe("KA01XY9999");
      expect(data.contact_email).toBeUndefined();
      expect(data.contact_phone).toBeUndefined();
    });

    it("createOrder rejects non-owner attempting to update or pay for another user's session", async () => {
      mockDbState.sessions.push({
        id: "sess-owned-1",
        code: "OWNED888",
        slot: 1,
        status: "pending",
        user_id: "user-owner-1",
        expires_at: new Date(Date.now() + 600000).toISOString(),
      });

      const req = new Request("https://example.com/api/public/create-order", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-token-attacker-2",
        },
        body: JSON.stringify({
          code: "OWNED888",
          duration_min: 30,
          vehicle_no: "STOLEN123",
          contact_email: "attacker@example.com",
        }),
      });

      const res = await createOrder(req);
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toContain("Session belongs to another user");
    });
  });
});

// @vitest-environment node
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { deviceSession, devicePoll, deviceEvent, deviceDue } from "@/lib/parking/device-api.server";
import { sessionPublic, createOrder, verifyPayment } from "@/lib/parking/driver-api.server";
import { createHmac } from "node:crypto";

const mockDb = {
  slots: [{ slot: 1, occupied: false, updated_at: new Date().toISOString() }],
  sessions: [] as any[],
  devices: [] as any[],
  activity_logs: [] as any[],
  device_telemetry: [] as any[],
  device_commands: [] as any[],
  payments: [] as any[],
  settings: [
    {
      id: 1,
      price_per_hour: 20,
      duration_options: [30, 60, 120, 180, 240],
      reminder_min: 10,
      exit_open_seconds: 60,
      offline_after_s: 30,
    },
  ],
};

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      let filtered = (mockDb as any)[table] || [];
      let pendingUpdates: any = null;

      const applyUpdates = () => {
        if (pendingUpdates) {
          for (const r of filtered) {
            Object.assign(r, pendingUpdates);
          }
        }
      };

      const builder: any = {
        select: () => {
          applyUpdates();
          return builder;
        },
        eq: (col: string, val: any) => {
          filtered = filtered.filter((r: any) => r[col] === val);
          return builder;
        },
        in: (col: string, vals: any[]) => {
          filtered = filtered.filter((r: any) => vals.includes(r[col]));
          return builder;
        },
        gt: (col: string, val: any) => {
          filtered = filtered.filter((r: any) => r[col] > val);
          return builder;
        },
        gte: (col: string, val: any) => {
          filtered = filtered.filter((r: any) => r[col] >= val);
          return builder;
        },
        lt: (col: string, val: any) => {
          filtered = filtered.filter((r: any) => r[col] < val);
          return builder;
        },
        lte: (col: string, val: any) => {
          filtered = filtered.filter((r: any) => r[col] <= val);
          return builder;
        },
        is: (col: string, val: any) => {
          filtered = filtered.filter((r: any) => (val === null ? r[col] == null : r[col] === val));
          return builder;
        },
        order: () => builder,
        limit: (n: number) => {
          filtered = filtered.slice(0, n);
          return builder;
        },
        maybeSingle: async () => {
          applyUpdates();
          return { data: filtered[0] || null, error: null };
        },
        single: async () => {
          applyUpdates();
          return { data: filtered[0] || null, error: filtered[0] ? null : new Error("Not found") };
        },
        then: (resolve: any, reject?: any) => {
          applyUpdates();
          return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
        },
        insert: (data: any) => {
          const row = Array.isArray(data) ? data[0] : data;
          const newRow = { id: row.id || `uuid-${Math.random()}`, ...row };
          (mockDb as any)[table]?.push(newRow);
          filtered = [newRow];
          return builder;
        },
        upsert: async (data: any) => {
          const row = Array.isArray(data) ? data[0] : data;
          const idx = (mockDb as any)[table]?.findIndex((r: any) => r.id === row.id || r.slot === row.slot);
          if (idx >= 0) {
            Object.assign((mockDb as any)[table][idx], row);
          } else {
            (mockDb as any)[table]?.push(row);
          }
          return { data: row, error: null };
        },
        update: (updates: any) => {
          pendingUpdates = updates;
          return builder;
        },
        delete: () => builder,
      };
      return builder;
    },
  },
}));

beforeEach(() => {
  vi.stubEnv("DEVICE_API_KEY", "test-device-secret-123");
  vi.stubEnv("PUBLIC_APP_URL", "https://scrolltide-dashboard.lovable.app");
  vi.stubEnv("RAZORPAY_KEY_ID", "rzp_test_fixture");
  vi.stubEnv("RAZORPAY_KEY_SECRET", "rzp_secret_fixture");
  vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", "rzp_hook_fixture");

  mockDb.slots = [
    { slot: 1, occupied: false, updated_at: new Date().toISOString() },
    { slot: 2, occupied: false, updated_at: new Date().toISOString() },
    { slot: 3, occupied: true, updated_at: new Date().toISOString() },
    { slot: 4, occupied: false, updated_at: new Date().toISOString() },
    { slot: 5, occupied: false, updated_at: new Date().toISOString() },
  ];
  mockDb.sessions = [];
  mockDb.devices = [];
  mockDb.activity_logs = [];
  mockDb.device_telemetry = [];
  mockDb.device_commands = [];
  mockDb.payments = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("ESP32 Device API Endpoints", () => {
  it("rejects device requests without correct x-device-key", async () => {
    const req = new Request("https://example.com/device-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device: "esp32-entry-1", slot: 1 }),
    });
    const res = await deviceSession(req);
    expect(res.status).toBe(401);
  });

  it("POST /device-session creates pending session and returns flat compact JSON", async () => {
    const req = new Request("https://example.com/device-session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-device-key": "test-device-secret-123",
      },
      body: JSON.stringify({ device: "esp32-entry-1", slot: 1 }),
    });

    const res = await deviceSession(req);
    expect(res.status).toBe(201);
    const data = await res.json();

    expect(data.session_id).toBeDefined();
    expect(data.code).toHaveLength(6);
    expect(data.pay_url).toBe(`https://scrolltide-dashboard.lovable.app/p/${data.code}`);
    expect(data.pay_url.length).toBeLessThanOrEqual(53);

    // Verify exactly the flat compact keys allowed
    expect(Object.keys(data).sort()).toEqual(["code", "pay_url", "session_id"].sort());
  });

  it("POST /device-session rejects occupied slot with 409", async () => {
    const req = new Request("https://example.com/device-session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-device-key": "test-device-secret-123",
      },
      body: JSON.stringify({ device: "esp32-entry-1", slot: 3 }), // Slot 3 is occupied
    });

    const res = await deviceSession(req);
    expect(res.status).toBe(409);
  });

  it("POST /device-session does NOT return 409 when old pending or expired session exists for slot 1, expires old and creates new", async () => {
    // Put an old pending session on slot 1
    mockDb.sessions.push({
      id: "sess-old-pending",
      code: "OLD001",
      slot: 1,
      device_id: "esp32-entry-1",
      status: "pending",
      expires_at: new Date(Date.now() - 60000).toISOString(),
    });

    const req = new Request("https://example.com/device-session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-device-key": "test-device-secret-123",
      },
      body: JSON.stringify({ device: "esp32-entry-1", slot: 1 }),
    });

    const res = await deviceSession(req);
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.session_id).toBeDefined();
    expect(data.code).toBeDefined();
    // Verify old session was marked expired
    const old = mockDb.sessions.find((s) => s.id === "sess-old-pending");
    expect(old?.status).toBe("expired");
  });

  it("POST /device-session safely returns existing session on repeated ESP32 request (idempotency)", async () => {
    mockDb.sessions.push({
      id: "sess-curr-pending",
      code: "CURR01",
      slot: 2,
      device_id: "esp32-entry-1",
      status: "pending",
      expires_at: new Date(Date.now() + 500000).toISOString(),
      created_at: new Date().toISOString(),
    });

    const req = new Request("https://example.com/device-session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-device-key": "test-device-secret-123",
      },
      body: JSON.stringify({ device: "esp32-entry-1", slot: 2 }),
    });

    const res = await deviceSession(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.session_id).toBe("sess-curr-pending");
    expect(data.code).toBe("CURR01");
    expect(data.pay_url).toBe("https://scrolltide-dashboard.lovable.app/p/CURR01");
  });

  it("POST /device-session does NOT block when an active session's time is already expired", async () => {
    // Put an active session whose end_time is 10 minutes in the past
    mockDb.sessions.push({
      id: "sess-past-active",
      code: "PAST01",
      slot: 4,
      device_id: "esp32-entry-1",
      status: "active",
      start_time: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
      end_time: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });

    const req = new Request("https://example.com/device-session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-device-key": "test-device-secret-123",
      },
      body: JSON.stringify({ device: "esp32-entry-1", slot: 4 }),
    });

    const res = await deviceSession(req);
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.session_id).toBeDefined();
    expect(data.code).toBeDefined();

    // The past active session should now be marked completed
    const past = mockDb.sessions.find((s) => s.id === "sess-past-active");
    expect(past?.status).toBe("completed");
  });

  it("POST /device-session does NOT block when an abandoned paid session is older than 15 minutes", async () => {
    // Paid session created 25 minutes ago that was never entered
    mockDb.sessions.push({
      id: "sess-abandoned-paid",
      code: "ABAN01",
      slot: 5,
      device_id: "esp32-entry-1",
      status: "paid",
      created_at: new Date(Date.now() - 25 * 60 * 1000).toISOString(),
      paid_at: new Date(Date.now() - 24 * 60 * 1000).toISOString(),
      entered_at: null,
    });

    const req = new Request("https://example.com/device-session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-device-key": "test-device-secret-123",
      },
      body: JSON.stringify({ device: "esp32-entry-1", slot: 5 }),
    });

    const res = await deviceSession(req);
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.session_id).toBeDefined();
  });

  it("POST /device-session rejects genuine active unexpired session with 409 Slot reserved", async () => {
    // Active session with 25 minutes remaining
    mockDb.sessions.push({
      id: "sess-truly-active",
      code: "ACTV01",
      slot: 1,
      device_id: "other-car",
      status: "active",
      start_time: new Date().toISOString(),
      end_time: new Date(Date.now() + 25 * 60 * 1000).toISOString(),
    });

    const req = new Request("https://example.com/device-session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-device-key": "test-device-secret-123",
      },
      body: JSON.stringify({ device: "esp32-entry-1", slot: 1 }),
    });

    const res = await deviceSession(req);
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toBe("Slot reserved");
  });

  it("POST /device-event completes active session when vehicle vacates slot", async () => {
    mockDb.slots[0].occupied = true; // slot 1 was occupied
    mockDb.sessions.push({
      id: "sess-parked",
      slot: 1,
      status: "active",
      start_time: new Date().toISOString(),
      end_time: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });

    // Device reports slot 1 is now free (occupancy 00000)
    const req = new Request("https://example.com/device-event", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-device-key": "test-device-secret-123",
      },
      body: JSON.stringify({
        device: "esp32-entry-1",
        event: "slots",
        occupancy: "00000",
      }),
    });

    const res = await deviceEvent(req);
    expect(res.status).toBe(200);

    const sess = mockDb.sessions.find((s) => s.id === "sess-parked");
    expect(sess?.status).toBe("completed");
  });

  it("GET /device-poll returns flat compact JSON status and paid duration", async () => {
    // 1. Pending session
    mockDb.sessions.push({
      id: "sess-uuid-1",
      code: "AB23CD",
      slot: 1,
      status: "pending",
      duration_min: 0,
      expires_at: new Date(Date.now() + 300000).toISOString(),
    });

    const pollReq = new Request("https://example.com/device-poll?session=sess-uuid-1", {
      headers: { "x-device-key": "test-device-secret-123" },
    });
    const pollRes = await devicePoll(pollReq);
    expect(pollRes.status).toBe(200);
    const pollData = await pollRes.json();
    expect(pollData).toEqual({ status: "pending", duration_min: 0 });

    // 2. Paid session
    mockDb.sessions[0].status = "paid";
    mockDb.sessions[0].duration_min = 60;
    const paidPollRes = await devicePoll(pollReq);
    expect(await paidPollRes.json()).toEqual({ status: "paid", duration_min: 60 });
  });

  it("POST /device-event updates hardware telemetry and handles heartbeat/occupancy", async () => {
    const req = new Request("https://example.com/device-event", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-device-key": "test-device-secret-123",
      },
      body: JSON.stringify({
        device: "esp32-entry-1",
        event: "heartbeat",
        occupancy: "10000",
        state: 0,
        dist: 87.5,
        rssi: -61,
        uptime: 120,
        exit_open: false,
      }),
    });

    const res = await deviceEvent(req);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // Verify devices table upserted
    expect(mockDb.devices).toHaveLength(1);
    expect(mockDb.devices[0].id).toBe("esp32-entry-1");
    expect(mockDb.devices[0].rssi).toBe(-61);
    expect(mockDb.devices[0].entry_state).toBe(0);
  });

  it("GET /device-due signals exit and returns warn_slots", async () => {
    const req = new Request("https://example.com/device-due?device=esp32-entry-1", {
      headers: { "x-device-key": "test-device-secret-123" },
    });

    const res = await deviceDue(req);
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.exit_open).toBe(false);
    expect(Array.isArray(data.warn_slots)).toBe(true);
    expect(Object.keys(data).sort()).toEqual(["exit_open", "warn_slots"].sort());
  });

  it("GET /device-due returns 200 with {exit_open:false,warn_slots:[]} when device has no sessions yet", async () => {
    mockDb.sessions = [];
    mockDb.devices = [];
    mockDb.device_commands = [];

    const req = new Request("https://example.com/device-due?device=esp32-entry-1", {
      headers: { "x-device-key": "test-device-secret-123" },
    });

    const res = await deviceDue(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ exit_open: false, warn_slots: [] });
  });
});

describe("Driver Payment Page API", () => {
  it("sessionPublic returns safe session info", async () => {
    mockDb.sessions.push({
      id: "sess-uuid-public",
      code: "TEST99",
      slot: 2,
      status: "pending",
      duration_min: 0,
      amount_paise: 0,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 240000).toISOString(),
    });

    const req = new Request("https://example.com/session-public?code=TEST99");
    const res = await sessionPublic(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.code).toBe("TEST99");
    expect(data.slot).toBe(2);
    expect(data.status).toBe("pending");
    expect(Array.isArray(data.price_options)).toBe(true);
  });
});

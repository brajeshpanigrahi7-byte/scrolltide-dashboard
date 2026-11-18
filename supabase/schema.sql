-- ParkSense Smart Parking Schema & Realtime Setup

-- 1. Devices table
CREATE TABLE IF NOT EXISTS public.devices (
  id text PRIMARY KEY,
  last_seen timestamptz,
  rssi int,
  uptime_s int,
  entry_state int DEFAULT 0,
  exit_open boolean DEFAULT false,
  boot_at timestamptz
);

-- 2. Slots table (slots 1 to 5)
CREATE TABLE IF NOT EXISTS public.slots (
  slot int PRIMARY KEY CHECK (slot BETWEEN 1 AND 5),
  occupied boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Seed slots 1-5 if not present
INSERT INTO public.slots (slot, occupied, updated_at)
VALUES (1, false, now()), (2, false, now()), (3, false, now()), (4, false, now()), (5, false, now())
ON CONFLICT (slot) DO NOTHING;

-- 3. Sessions table
CREATE TABLE IF NOT EXISTS public.sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL,
  device_id text,
  slot int NOT NULL CHECK (slot BETWEEN 1 AND 5),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'active', 'completed', 'expired', 'cancelled')),
  duration_min int,
  amount_paise int,
  vehicle_no text,
  contact_email text,
  contact_phone text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  paid_at timestamptz,
  entered_at timestamptz,
  start_time timestamptz,
  end_time timestamptz,
  reminder_sent boolean NOT NULL DEFAULT false,
  exit_signalled_at timestamptz
);

CREATE INDEX IF NOT EXISTS sessions_status_idx ON public.sessions (status);
CREATE INDEX IF NOT EXISTS sessions_code_idx ON public.sessions (code);
CREATE INDEX IF NOT EXISTS sessions_end_time_idx ON public.sessions (end_time);

-- 4. Payments table
CREATE TABLE IF NOT EXISTS public.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid REFERENCES public.sessions(id) ON DELETE SET NULL,
  razorpay_order_id text UNIQUE NOT NULL,
  razorpay_payment_id text UNIQUE,
  amount_paise int NOT NULL,
  kind text NOT NULL CHECK (kind IN ('new', 'extend')),
  duration_min int NOT NULL,
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'captured', 'failed', 'needs_refund')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payments_order_idx ON public.payments (razorpay_order_id);

-- 5. Device Telemetry table
CREATE TABLE IF NOT EXISTS public.device_telemetry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ts timestamptz NOT NULL DEFAULT now(),
  device_id text NOT NULL,
  dist_cm numeric,
  rssi int,
  occupancy text,
  entry_state int
);

CREATE INDEX IF NOT EXISTS device_telemetry_ts_idx ON public.device_telemetry (ts DESC);

-- 6. Activity Logs table
CREATE TABLE IF NOT EXISTS public.activity_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ts timestamptz NOT NULL DEFAULT now(),
  device_id text,
  type text NOT NULL,
  slot int,
  session_id uuid,
  message text
);

CREATE INDEX IF NOT EXISTS activity_logs_ts_idx ON public.activity_logs (ts DESC);

-- 7. Device Commands table
CREATE TABLE IF NOT EXISTS public.device_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id text NOT NULL,
  command text NOT NULL CHECK (command IN ('open_exit')),
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz
);

-- 8. Settings table (single row)
CREATE TABLE IF NOT EXISTS public.settings (
  id int PRIMARY KEY DEFAULT 1,
  price_per_hour numeric NOT NULL DEFAULT 20,
  duration_options jsonb NOT NULL DEFAULT '[30, 60, 120, 180, 240]'::jsonb,
  reminder_min int NOT NULL DEFAULT 10,
  exit_open_seconds int NOT NULL DEFAULT 60,
  offline_after_s int NOT NULL DEFAULT 30
);

INSERT INTO public.settings (id, price_per_hour, duration_options, reminder_min, exit_open_seconds, offline_after_s)
VALUES (1, 20, '[30, 60, 120, 180, 240]'::jsonb, 10, 60, 30)
ON CONFLICT (id) DO NOTHING;

-- 9. User Roles table for admin login
CREATE TABLE IF NOT EXISTS public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  role text NOT NULL DEFAULT 'admin'
);

-- Grants & Row Level Security
ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_telemetry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- Service role full access
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;

-- Grants on device_commands
GRANT SELECT, INSERT, UPDATE, DELETE ON public.device_commands TO authenticated;
GRANT SELECT, UPDATE ON public.device_commands TO anon;
GRANT ALL ON public.device_commands TO service_role;

-- Authenticated admins can SELECT all tables
CREATE POLICY admin_select_devices ON public.devices FOR SELECT TO authenticated USING (true);
CREATE POLICY admin_select_slots ON public.slots FOR SELECT TO authenticated USING (true);
CREATE POLICY admin_select_sessions ON public.sessions FOR SELECT TO authenticated USING (true);
CREATE POLICY admin_select_payments ON public.payments FOR SELECT TO authenticated USING (true);
CREATE POLICY admin_select_telemetry ON public.device_telemetry FOR SELECT TO authenticated USING (true);
CREATE POLICY admin_select_logs ON public.activity_logs FOR SELECT TO authenticated USING (true);
CREATE POLICY admin_manage_settings ON public.settings FOR ALL TO authenticated USING (true);
CREATE POLICY admin_select_roles ON public.user_roles FOR SELECT TO authenticated USING (true);

-- device_commands RLS policies
CREATE POLICY admins_insert_commands ON public.device_commands
  FOR INSERT TO authenticated
  WITH CHECK (true);

CREATE POLICY admins_select_commands ON public.device_commands
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY admins_update_commands ON public.device_commands
  FOR UPDATE TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY anon_read_pending_commands ON public.device_commands
  FOR SELECT TO anon
  USING (consumed_at IS NULL);

CREATE POLICY anon_update_pending_commands ON public.device_commands
  FOR UPDATE TO anon
  USING (consumed_at IS NULL)
  WITH CHECK (consumed_at IS NOT NULL);

-- Enable Supabase Realtime
DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.slots;
  EXCEPTION WHEN duplicate_object THEN END;

  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.sessions;
  EXCEPTION WHEN duplicate_object THEN END;

  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.devices;
  EXCEPTION WHEN duplicate_object THEN END;

  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.activity_logs;
  EXCEPTION WHEN duplicate_object THEN END;

  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.device_telemetry;
  EXCEPTION WHEN duplicate_object THEN END;
END $$;

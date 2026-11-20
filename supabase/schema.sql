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
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
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
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON public.sessions (user_id);

-- 3b. Parking Sessions table (legacy & compatibility support)
CREATE TABLE IF NOT EXISTS public.parking_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  slot int NOT NULL CHECK (slot BETWEEN 1 AND 5),
  amount_inr int NOT NULL CHECK (amount_inr BETWEEN 20 AND 200 AND amount_inr % 20 = 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','used','expired')),
  payment_link_id text UNIQUE,
  short_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz
);

CREATE INDEX IF NOT EXISTS parking_sessions_user_id_idx ON public.parking_sessions (user_id);

-- 4. Payments table
CREATE TABLE IF NOT EXISTS public.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
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

-- 9. User Roles table for admin login (no default role, new sign-ups do not get admin automatically)
CREATE TABLE IF NOT EXISTS public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  role text NOT NULL
);

-- 10. Role Verification Function (SECURITY DEFINER to avoid recursion in RLS)
CREATE OR REPLACE FUNCTION public.has_role(user_uuid uuid, required_role text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
BEGIN
  IF user_uuid IS NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = user_uuid AND role = required_role
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.has_role(uuid, text) TO authenticated, anon;

-- Grants & Row Level Security
ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.parking_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_telemetry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- Service role full access
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;

-- Revoke write privileges on sensitive operational tables from unauthenticated/anon callers
REVOKE INSERT, UPDATE, DELETE ON public.user_roles FROM authenticated, anon;
REVOKE INSERT, UPDATE, DELETE ON public.parking_sessions FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.sessions FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.payments FROM anon;

-- Row Level Security policies for sessions (authenticated users read/modify own records, admins manage all)
DROP POLICY IF EXISTS admin_select_sessions ON public.sessions;
DROP POLICY IF EXISTS user_select_sessions ON public.sessions;
CREATE POLICY user_select_sessions ON public.sessions FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS user_update_sessions ON public.sessions;
CREATE POLICY user_update_sessions ON public.sessions FOR UPDATE TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS user_delete_sessions ON public.sessions;
CREATE POLICY user_delete_sessions ON public.sessions FOR DELETE TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS user_insert_sessions ON public.sessions;
CREATE POLICY user_insert_sessions ON public.sessions FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));

-- Row Level Security policies for parking_sessions
DROP POLICY IF EXISTS operators_read_sessions ON public.parking_sessions;
DROP POLICY IF EXISTS user_select_parking_sessions ON public.parking_sessions;
CREATE POLICY user_select_parking_sessions ON public.parking_sessions FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS user_update_parking_sessions ON public.parking_sessions;
CREATE POLICY user_update_parking_sessions ON public.parking_sessions FOR UPDATE TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS user_delete_parking_sessions ON public.parking_sessions;
CREATE POLICY user_delete_parking_sessions ON public.parking_sessions FOR DELETE TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS user_insert_parking_sessions ON public.parking_sessions;
CREATE POLICY user_insert_parking_sessions ON public.parking_sessions FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));

-- Row Level Security policies for payments
DROP POLICY IF EXISTS admin_select_payments ON public.payments;
DROP POLICY IF EXISTS user_select_payments ON public.payments;
CREATE POLICY user_select_payments ON public.payments FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));

-- Authenticated admins can SELECT operational tables
DROP POLICY IF EXISTS admin_select_devices ON public.devices;
CREATE POLICY admin_select_devices ON public.devices FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS admin_select_slots ON public.slots;
CREATE POLICY admin_select_slots ON public.slots FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS admin_select_telemetry ON public.device_telemetry;
CREATE POLICY admin_select_telemetry ON public.device_telemetry FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS admin_select_logs ON public.activity_logs;
CREATE POLICY admin_select_logs ON public.activity_logs FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS admin_manage_settings ON public.settings;
CREATE POLICY admin_manage_settings ON public.settings FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS public_read_settings ON public.settings;
CREATE POLICY public_read_settings ON public.settings FOR SELECT TO authenticated, anon USING (true);

DROP POLICY IF EXISTS admin_select_roles ON public.user_roles;
CREATE POLICY admin_select_roles ON public.user_roles FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin') OR auth.uid() = user_id);

-- device_commands RLS policies
DROP POLICY IF EXISTS admins_insert_commands ON public.device_commands;
CREATE POLICY admins_insert_commands ON public.device_commands
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS admins_select_commands ON public.device_commands;
CREATE POLICY admins_select_commands ON public.device_commands
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS admins_update_commands ON public.device_commands;
CREATE POLICY admins_update_commands ON public.device_commands
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS anon_read_pending_commands ON public.device_commands;
CREATE POLICY anon_read_pending_commands ON public.device_commands
  FOR SELECT TO anon
  USING (consumed_at IS NULL);

DROP POLICY IF EXISTS anon_update_pending_commands ON public.device_commands;
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

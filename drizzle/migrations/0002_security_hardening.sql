-- Migration: 0002_security_hardening.sql
-- Description: Fixes 8 Lovable security findings (admin role enforcement, RLS privilege isolation, and SECURITY DEFINER role check)

-- 1. Helper function: has_role (SECURITY DEFINER to avoid recursion in RLS)
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

-- 2. Remove default role assignment on user_roles so signups never get admin automatically
ALTER TABLE public.user_roles ALTER COLUMN role DROP DEFAULT;

-- 3. Hardening user_roles table RLS
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admin_select_roles ON public.user_roles;
CREATE POLICY admin_select_roles ON public.user_roles
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR auth.uid() = user_id);

-- Explicitly revoke write permissions from authenticated and anon
REVOKE INSERT, UPDATE, DELETE ON public.user_roles FROM authenticated, anon;

-- 4. Hardening settings table RLS
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admin_manage_settings ON public.settings;
CREATE POLICY admin_manage_settings ON public.settings
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS public_read_settings ON public.settings;
CREATE POLICY public_read_settings ON public.settings
  FOR SELECT TO authenticated, anon
  USING (true);

-- 5. Hardening device_commands table RLS
ALTER TABLE public.device_commands ENABLE ROW LEVEL SECURITY;

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

-- 6. Hardening admin_select_* policies on live operational data
DROP POLICY IF EXISTS admin_select_devices ON public.devices;
CREATE POLICY admin_select_devices ON public.devices
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS admin_select_slots ON public.slots;
CREATE POLICY admin_select_slots ON public.slots
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS admin_select_sessions ON public.sessions;
CREATE POLICY admin_select_sessions ON public.sessions
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS admin_select_payments ON public.payments;
CREATE POLICY admin_select_payments ON public.payments
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS admin_select_telemetry ON public.device_telemetry;
CREATE POLICY admin_select_telemetry ON public.device_telemetry
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS admin_select_logs ON public.activity_logs;
CREATE POLICY admin_select_logs ON public.activity_logs
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

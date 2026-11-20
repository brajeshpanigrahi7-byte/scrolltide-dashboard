-- Migration: 0003_sessions_rls_and_tokens.sql
-- Description: Enforces RLS on parking_sessions and sessions tables with user_id ownership,
--              blocks unauthenticated writes, and hardens user role isolation.

-- 1. Ensure user_id column exists on public.parking_sessions
ALTER TABLE public.parking_sessions ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;

-- 2. Ensure user_id column exists on public.sessions
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;

-- 3. Ensure user_id column exists on public.payments
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;

-- 4. Enable Row Level Security on parking_sessions
ALTER TABLE public.parking_sessions ENABLE ROW LEVEL SECURITY;

-- Revoke all write permissions from anon on parking_sessions
REVOKE INSERT, UPDATE, DELETE ON public.parking_sessions FROM anon;
GRANT ALL ON public.parking_sessions TO service_role;

-- Drop old policies on parking_sessions
DROP POLICY IF EXISTS operators_read_sessions ON public.parking_sessions;
DROP POLICY IF EXISTS user_select_parking_sessions ON public.parking_sessions;
DROP POLICY IF EXISTS user_update_parking_sessions ON public.parking_sessions;
DROP POLICY IF EXISTS user_delete_parking_sessions ON public.parking_sessions;
DROP POLICY IF EXISTS user_insert_parking_sessions ON public.parking_sessions;

-- Create user_id and admin RLS policies for parking_sessions
CREATE POLICY user_select_parking_sessions ON public.parking_sessions
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY user_update_parking_sessions ON public.parking_sessions
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY user_delete_parking_sessions ON public.parking_sessions
  FOR DELETE TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY user_insert_parking_sessions ON public.parking_sessions
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));

-- 5. Enable Row Level Security on sessions
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;

-- Revoke write permissions from anon on sessions
REVOKE INSERT, UPDATE, DELETE ON public.sessions FROM anon;
GRANT ALL ON public.sessions TO service_role;

-- Drop old policies on sessions
DROP POLICY IF EXISTS admin_select_sessions ON public.sessions;
DROP POLICY IF EXISTS user_select_sessions ON public.sessions;
DROP POLICY IF EXISTS user_update_sessions ON public.sessions;
DROP POLICY IF EXISTS user_delete_sessions ON public.sessions;
DROP POLICY IF EXISTS user_insert_sessions ON public.sessions;

-- Create user_id and admin RLS policies for sessions
CREATE POLICY user_select_sessions ON public.sessions
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY user_update_sessions ON public.sessions
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY user_delete_sessions ON public.sessions
  FOR DELETE TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY user_insert_sessions ON public.sessions
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));

-- 6. Enable Row Level Security on payments with user_id check
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

REVOKE INSERT, UPDATE, DELETE ON public.payments FROM anon;
GRANT ALL ON public.payments TO service_role;

DROP POLICY IF EXISTS admin_select_payments ON public.payments;
DROP POLICY IF EXISTS user_select_payments ON public.payments;

CREATE POLICY user_select_payments ON public.payments
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));

-- 7. Ensure regular users cannot update user_roles
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE ON public.user_roles FROM authenticated, anon;
GRANT ALL ON public.user_roles TO service_role;

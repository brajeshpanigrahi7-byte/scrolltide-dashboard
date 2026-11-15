-- Migration 0001: Device API schema evolution
-- Evolves parking_sessions from payment-link to full device/driver flow

-- 1. Activity Logs table
CREATE TABLE public.activity_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device text NOT NULL,
  event text NOT NULL CHECK (event IN ('heartbeat','slots','entered','cancelled','session_created','payment_received','session_expired','reminder_sent')),
  session_id uuid REFERENCES public.parking_sessions(id),
  slot int CHECK (slot IS NULL OR slot BETWEEN 1 AND 5),
  occupancy text,
  meta jsonb DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_logs_created_at_idx ON public.activity_logs (created_at DESC);
CREATE INDEX activity_logs_device_idx ON public.activity_logs (device);
GRANT SELECT ON public.activity_logs TO authenticated;
GRANT ALL ON public.activity_logs TO service_role;
ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY operators_read_logs ON public.activity_logs FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.parking_operators WHERE user_id = auth.uid()));
ALTER PUBLICATION supabase_realtime ADD TABLE public.activity_logs;

-- 2. ESP32 Devices table
CREATE TABLE public.esp32_devices (
  device text PRIMARY KEY,
  slot_occupancy text DEFAULT '00000',
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.esp32_devices TO authenticated;
GRANT ALL ON public.esp32_devices TO service_role;
ALTER TABLE public.esp32_devices ENABLE ROW LEVEL SECURITY;
CREATE POLICY operators_read_devices ON public.esp32_devices FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.parking_operators WHERE user_id = auth.uid()));
ALTER PUBLICATION supabase_realtime ADD TABLE public.esp32_devices;

-- 3. Evolve parking_sessions
-- Add new columns
ALTER TABLE public.parking_sessions ADD COLUMN code text UNIQUE;
ALTER TABLE public.parking_sessions ADD COLUMN duration_min int DEFAULT 30;
ALTER TABLE public.parking_sessions ADD COLUMN driver_email text;
ALTER TABLE public.parking_sessions ADD COLUMN driver_phone text;
ALTER TABLE public.parking_sessions ADD COLUMN entered_at timestamptz;
ALTER TABLE public.parking_sessions ADD COLUMN ends_at timestamptz;
ALTER TABLE public.parking_sessions ADD COLUMN exit_signalled boolean DEFAULT false;
ALTER TABLE public.parking_sessions ADD COLUMN reminder_sent boolean DEFAULT false;
ALTER TABLE public.parking_sessions ADD COLUMN razorpay_order_id text;
ALTER TABLE public.parking_sessions ADD COLUMN razorpay_payment_id text;

-- Migrate existing status values:  pending -> awaiting_payment, used -> completed
UPDATE public.parking_sessions SET status = 'awaiting_payment' WHERE status = 'pending';
UPDATE public.parking_sessions SET status = 'completed' WHERE status = 'used';

-- Drop the old check constraint and add the new one
ALTER TABLE public.parking_sessions DROP CONSTRAINT IF EXISTS parking_sessions_status_check;
ALTER TABLE public.parking_sessions ADD CONSTRAINT parking_sessions_status_check
  CHECK (status IN ('awaiting_payment','paid','active','completed','expired','cancelled'));

-- Relax amount constraint for extensions (amounts can be multiples of ₹20)
ALTER TABLE public.parking_sessions DROP CONSTRAINT IF EXISTS parking_sessions_amount_inr_check;
ALTER TABLE public.parking_sessions ADD CONSTRAINT parking_sessions_amount_inr_check
  CHECK (amount_inr >= 20 AND amount_inr % 20 = 0);

-- Backfill code for existing rows (they won't need it but keeps column NOT NULL feasible later)
-- For existing rows, generate codes from their id prefix
UPDATE public.parking_sessions SET code = upper(substr(replace(id::text, '-', ''), 1, 6))
  WHERE code IS NULL;

-- Index on code for driver page lookups
CREATE INDEX parking_sessions_code_idx ON public.parking_sessions (code);
-- Index for device-due queries
CREATE INDEX parking_sessions_active_ends_idx ON public.parking_sessions (ends_at)
  WHERE status = 'active' AND exit_signalled = false;
-- Index for reminder queries
CREATE INDEX parking_sessions_reminder_idx ON public.parking_sessions (ends_at)
  WHERE status = 'active' AND reminder_sent = false;

-- 4. Drop the old consume function and replace with new helpers
DROP FUNCTION IF EXISTS public.consume_parking_session(uuid);

-- Signal exit: atomically set exit_signalled and status=completed for one due session
CREATE FUNCTION public.signal_exit_and_complete()
RETURNS TABLE(session_id uuid, slot int) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  UPDATE public.parking_sessions
     SET exit_signalled = true, status = 'completed'
   WHERE id = (
     SELECT ps.id FROM public.parking_sessions ps
      WHERE ps.status = 'active' AND ps.exit_signalled = false AND ps.ends_at <= now()
      ORDER BY ps.ends_at LIMIT 1
      FOR UPDATE SKIP LOCKED
   )
  RETURNING public.parking_sessions.id AS session_id, public.parking_sessions.slot;
END;
$$;
REVOKE ALL ON FUNCTION public.signal_exit_and_complete() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.signal_exit_and_complete() TO service_role;

-- Expire old awaiting_payment sessions (>10 min)
CREATE FUNCTION public.expire_stale_sessions() RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE cnt int;
BEGIN
  UPDATE public.parking_sessions
     SET status = 'expired'
   WHERE status = 'awaiting_payment' AND created_at + interval '10 minutes' <= now();
  GET DIAGNOSTICS cnt = ROW_COUNT;
  RETURN cnt;
END;
$$;
REVOKE ALL ON FUNCTION public.expire_stale_sessions() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_stale_sessions() TO service_role;

CREATE TYPE public.app_role AS ENUM ('admin');
CREATE TYPE public.parking_session_status AS ENUM ('pending','paid','active','completed','expired','cancelled');

CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  UNIQUE (user_id, role)
);
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role);
$$;
REVOKE ALL ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated, service_role;

CREATE POLICY users_read_own_roles ON public.user_roles FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));
INSERT INTO public.user_roles (user_id, role)
  SELECT user_id, 'admin'::public.app_role FROM public.parking_operators
  ON CONFLICT (user_id, role) DO NOTHING;

CREATE TABLE public.devices (
  id text PRIMARY KEY,
  last_seen timestamptz,
  rssi int,
  uptime_s int,
  entry_state int NOT NULL DEFAULT 0 CHECK (entry_state BETWEEN 0 AND 4),
  exit_open boolean NOT NULL DEFAULT false,
  boot_at timestamptz
);
GRANT SELECT ON public.devices TO authenticated;
GRANT ALL ON public.devices TO service_role;
ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY;
CREATE POLICY admins_read_devices ON public.devices FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

CREATE TABLE public.slots (
  slot int PRIMARY KEY CHECK (slot BETWEEN 1 AND 5),
  occupied boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.slots TO authenticated;
GRANT ALL ON public.slots TO service_role;
ALTER TABLE public.slots ENABLE ROW LEVEL SECURITY;
CREATE POLICY admins_read_slots ON public.slots FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
INSERT INTO public.slots (slot, occupied) VALUES (1,false),(2,false),(3,false),(4,false),(5,false);

CREATE TABLE public.sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$'),
  device_id text REFERENCES public.devices(id) ON DELETE SET NULL,
  slot int NOT NULL REFERENCES public.slots(slot),
  status public.parking_session_status NOT NULL DEFAULT 'pending',
  duration_min int NOT NULL DEFAULT 0 CHECK (duration_min >= 0),
  amount_paise int NOT NULL DEFAULT 0 CHECK (amount_paise >= 0),
  vehicle_no text,
  contact_email text,
  contact_phone text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '5 minutes'),
  paid_at timestamptz,
  entered_at timestamptz,
  start_time timestamptz,
  end_time timestamptz,
  reminder_sent boolean NOT NULL DEFAULT false,
  exit_signalled_at timestamptz
);
GRANT SELECT ON public.sessions TO authenticated;
GRANT ALL ON public.sessions TO service_role;
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY admins_read_sessions ON public.sessions FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
CREATE INDEX sessions_status_slot_idx ON public.sessions (status, slot);
CREATE INDEX sessions_created_at_idx ON public.sessions (created_at DESC);
CREATE INDEX sessions_due_idx ON public.sessions (end_time) WHERE status = 'active' AND exit_signalled_at IS NULL;

CREATE TABLE public.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  razorpay_order_id text NOT NULL UNIQUE,
  razorpay_payment_id text UNIQUE,
  amount_paise int NOT NULL CHECK (amount_paise > 0),
  kind text NOT NULL CHECK (kind IN ('new','extend')),
  duration_min int NOT NULL CHECK (duration_min > 0),
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created','captured','failed','needs_refund')),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.payments TO authenticated;
GRANT ALL ON public.payments TO service_role;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY admins_read_payments ON public.payments FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
CREATE INDEX payments_session_idx ON public.payments (session_id, created_at DESC);

CREATE TABLE public.device_telemetry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ts timestamptz NOT NULL DEFAULT now(),
  device_id text NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
  dist_cm numeric,
  rssi int,
  occupancy text CHECK (occupancy IS NULL OR occupancy ~ '^[01]{5}$'),
  entry_state int CHECK (entry_state IS NULL OR entry_state BETWEEN 0 AND 4)
);
GRANT SELECT ON public.device_telemetry TO authenticated;
GRANT ALL ON public.device_telemetry TO service_role;
ALTER TABLE public.device_telemetry ENABLE ROW LEVEL SECURITY;
CREATE POLICY admins_read_telemetry ON public.device_telemetry FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
CREATE INDEX telemetry_device_ts_idx ON public.device_telemetry (device_id, ts DESC);

CREATE TABLE public.activity_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device text,
  event text,
  device_id text,
  type text,
  ts timestamptz NOT NULL DEFAULT now(),
  session_id uuid,
  slot int CHECK (slot IS NULL OR slot BETWEEN 1 AND 5),
  occupancy text,
  meta jsonb DEFAULT '{}',
  message text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS device_id text;
ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS type text;
ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS ts timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.activity_logs ADD COLUMN IF NOT EXISTS message text;
ALTER TABLE public.activity_logs DROP CONSTRAINT IF EXISTS activity_logs_event_check;
UPDATE public.activity_logs SET device_id = device, type = event, ts = created_at, message = event WHERE device_id IS NULL;
GRANT SELECT ON public.activity_logs TO authenticated;
GRANT ALL ON public.activity_logs TO service_role;
ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;
CREATE INDEX activity_logs_ts_idx ON public.activity_logs (ts DESC);
CREATE POLICY admins_read_activity_logs ON public.activity_logs FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

CREATE TABLE public.device_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id text NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
  command text NOT NULL CHECK (command = 'open_exit'),
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz
);
GRANT SELECT ON public.device_commands TO authenticated;
GRANT ALL ON public.device_commands TO service_role;
ALTER TABLE public.device_commands ENABLE ROW LEVEL SECURITY;
CREATE POLICY admins_read_commands ON public.device_commands FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
CREATE INDEX device_commands_pending_idx ON public.device_commands (device_id, created_at) WHERE consumed_at IS NULL;

CREATE TABLE public.settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  price_per_hour numeric(10,2) NOT NULL DEFAULT 20 CHECK (price_per_hour > 0),
  duration_options int[] NOT NULL DEFAULT ARRAY[30,60,120,180,240],
  reminder_min int NOT NULL DEFAULT 10 CHECK (reminder_min BETWEEN 1 AND 120),
  exit_open_seconds int NOT NULL DEFAULT 60 CHECK (exit_open_seconds BETWEEN 5 AND 300),
  offline_after_s int NOT NULL DEFAULT 30 CHECK (offline_after_s BETWEEN 5 AND 600),
  telemetry_cleanup_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.settings TO authenticated;
GRANT ALL ON public.settings TO service_role;
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY admins_read_settings ON public.settings FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
INSERT INTO public.settings (id) VALUES (true);

CREATE TABLE public.api_rate_limits (
  key text PRIMARY KEY,
  window_start timestamptz NOT NULL DEFAULT now(),
  count int NOT NULL DEFAULT 1
);
GRANT ALL ON public.api_rate_limits TO service_role;
ALTER TABLE public.api_rate_limits ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='activity_logs') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.activity_logs;
  END IF;
END;
$$;
ALTER PUBLICATION supabase_realtime ADD TABLE public.devices;
ALTER PUBLICATION supabase_realtime ADD TABLE public.slots;
ALTER PUBLICATION supabase_realtime ADD TABLE public.sessions;
ALTER PUBLICATION supabase_realtime ADD TABLE public.device_telemetry;

CREATE OR REPLACE FUNCTION public.check_rate_limit(p_key text, p_limit int, p_window_seconds int)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE current_count int;
BEGIN
  INSERT INTO public.api_rate_limits (key) VALUES (p_key)
  ON CONFLICT (key) DO UPDATE SET
    window_start = CASE WHEN public.api_rate_limits.window_start + make_interval(secs => p_window_seconds) <= now()
      THEN now() ELSE public.api_rate_limits.window_start END,
    count = CASE WHEN public.api_rate_limits.window_start + make_interval(secs => p_window_seconds) <= now()
      THEN 1 ELSE public.api_rate_limits.count + 1 END
  RETURNING count INTO current_count;
  RETURN current_count <= p_limit;
END;
$$;
REVOKE ALL ON FUNCTION public.check_rate_limit(text,int,int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_rate_limit(text,int,int) TO service_role;

CREATE OR REPLACE FUNCTION public.create_device_session(p_device text, p_slot int, p_code text)
RETURNS public.sessions LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE created public.sessions;
BEGIN
  INSERT INTO public.devices (id, last_seen) VALUES (p_device, now())
    ON CONFLICT (id) DO UPDATE SET last_seen = now();
  PERFORM 1 FROM public.slots WHERE slot = p_slot FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.slots WHERE slot = p_slot AND occupied) OR
     EXISTS (SELECT 1 FROM public.sessions WHERE slot = p_slot AND status IN ('pending','paid','active')) THEN
    RAISE EXCEPTION 'SLOT_UNAVAILABLE';
  END IF;
  UPDATE public.sessions SET status = 'cancelled'
    WHERE device_id = p_device AND status = 'pending';
  INSERT INTO public.sessions (code, device_id, slot, expires_at)
    VALUES (p_code, p_device, p_slot, now() + interval '5 minutes') RETURNING * INTO created;
  INSERT INTO public.activity_logs (device,event,device_id,type,session_id,slot,message)
    VALUES (p_device,'session_created',p_device,'session_created',created.id,p_slot,'Parking session created; awaiting payment');
  RETURN created;
END;
$$;
REVOKE ALL ON FUNCTION public.create_device_session(text,int,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_device_session(text,int,text) TO service_role;

CREATE OR REPLACE FUNCTION public.mark_session_entered(p_session uuid)
RETURNS public.sessions LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE current public.sessions;
BEGIN
  SELECT * INTO current FROM public.sessions WHERE id = p_session FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SESSION_NOT_FOUND'; END IF;
  IF current.status <> 'paid' THEN RAISE EXCEPTION 'SESSION_NOT_PAID'; END IF;
  UPDATE public.sessions SET status = 'active', entered_at = now(), start_time = now(),
    end_time = now() + make_interval(mins => current.duration_min)
    WHERE id = p_session RETURNING * INTO current;
  INSERT INTO public.activity_logs (device,event,device_id,type,session_id,slot,message)
    VALUES (current.device_id,'entered',current.device_id,'entered',current.id,current.slot,'Vehicle entered; parking timer started');
  RETURN current;
END;
$$;
REVOKE ALL ON FUNCTION public.mark_session_entered(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_session_entered(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.mark_paid(p_order_id text, p_payment_id text, p_amount int)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE payment public.payments;
DECLARE current public.sessions;
BEGIN
  SELECT * INTO payment FROM public.payments WHERE razorpay_order_id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF payment.status = 'captured' THEN RETURN 'already_captured'; END IF;
  IF payment.status = 'needs_refund' THEN RETURN 'needs_refund'; END IF;
  IF payment.amount_paise <> p_amount THEN RETURN 'amount_mismatch'; END IF;
  IF p_payment_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.payments WHERE razorpay_payment_id = p_payment_id AND razorpay_order_id <> p_order_id
  ) THEN RETURN 'duplicate_payment'; END IF;
  SELECT * INTO current FROM public.sessions WHERE id = payment.session_id FOR UPDATE;
  IF payment.kind = 'new' AND current.status = 'pending' AND current.expires_at > now() THEN
    UPDATE public.payments SET status = 'captured', razorpay_payment_id = p_payment_id WHERE id = payment.id;
    UPDATE public.sessions SET status = 'paid', duration_min = payment.duration_min,
      amount_paise = amount_paise + payment.amount_paise, paid_at = now() WHERE id = current.id;
    INSERT INTO public.activity_logs (device,event,device_id,type,session_id,slot,message)
      VALUES (current.device_id,'payment_received',current.device_id,'paid',current.id,current.slot,'Razorpay payment confirmed; entry authorized');
    RETURN 'captured';
  ELSIF payment.kind = 'extend' AND current.status = 'active' AND current.exit_signalled_at IS NULL
    AND current.end_time > now() THEN
    UPDATE public.payments SET status = 'captured', razorpay_payment_id = p_payment_id WHERE id = payment.id;
    UPDATE public.sessions SET end_time = end_time + make_interval(mins => payment.duration_min),
      duration_min = duration_min + payment.duration_min, amount_paise = amount_paise + payment.amount_paise,
      reminder_sent = false WHERE id = current.id;
    INSERT INTO public.activity_logs (device,event,device_id,type,session_id,slot,message)
      VALUES (current.device_id,'payment_received',current.device_id,'extend',current.id,current.slot,'Extended by ' || payment.duration_min || ' min');
    RETURN 'captured';
  ELSE
    UPDATE public.payments SET status = 'needs_refund', razorpay_payment_id = p_payment_id WHERE id = payment.id;
    INSERT INTO public.activity_logs (device,event,device_id,type,session_id,slot,message)
      VALUES (COALESCE(current.device_id,'webhook'),'payment_received',current.device_id,'needs_refund',current.id,current.slot,'Payment arrived too late; manual refund required');
    RETURN 'needs_refund';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.mark_paid(text,text,int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_paid(text,text,int) TO service_role;

CREATE OR REPLACE FUNCTION public.device_due(p_device text, p_reminder_min int)
RETURNS TABLE(exit_open boolean, warn_slots int[]) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE due public.sessions;
DECLARE command public.device_commands;
DECLARE warned_slot int;
BEGIN
  SELECT * INTO due FROM public.sessions
    WHERE status = 'active' AND end_time <= now() AND exit_signalled_at IS NULL
    ORDER BY end_time LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF FOUND THEN
    UPDATE public.sessions SET exit_signalled_at = now(), status = 'completed' WHERE id = due.id;
    INSERT INTO public.activity_logs (device,event,device_id,type,session_id,slot,message)
      VALUES (COALESCE(due.device_id,p_device),'session_expired',due.device_id,'exit_opened',due.id,due.slot,'Exit gate signalled');
    exit_open := true;
  ELSE
    SELECT * INTO command FROM public.device_commands
      WHERE device_id = p_device AND command = 'open_exit' AND consumed_at IS NULL
      ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED;
    IF FOUND THEN
      UPDATE public.device_commands SET consumed_at = now() WHERE id = command.id;
      INSERT INTO public.activity_logs (device,event,device_id,type,message)
        VALUES (p_device,'session_expired',p_device,'exit_opened','Exit gate signalled by administrator');
      exit_open := true;
    ELSE
      exit_open := false;
    END IF;
  END IF;
  FOR warned_slot IN
    UPDATE public.sessions SET reminder_sent = true
      WHERE status = 'active' AND reminder_sent = false AND end_time > now()
        AND end_time <= now() + make_interval(mins => p_reminder_min)
      RETURNING slot
  LOOP
    INSERT INTO public.activity_logs (device,event,device_id,type,slot,message)
      VALUES (p_device,'reminder_sent',p_device,'reminder',warned_slot,p_reminder_min || '-minute reminder');
  END LOOP;
  SELECT COALESCE(array_agg(slot ORDER BY slot), ARRAY[]::int[]) INTO warn_slots
    FROM public.sessions WHERE status = 'active' AND end_time > now()
      AND end_time <= now() + make_interval(mins => p_reminder_min);
  RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION public.device_due(text,int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.device_due(text,int) TO service_role;

COMMENT ON TABLE public.parking_sessions IS 'DEPRECATED: replaced by sessions and payments for the ESP32 contract.';
DO $$
BEGIN
  IF to_regclass('public.esp32_devices') IS NOT NULL THEN
    COMMENT ON TABLE public.esp32_devices IS 'DEPRECATED: replaced by devices, slots, and device_telemetry.';
  END IF;
END;
$$;

CREATE TABLE public.parking_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 slot int NOT NULL CHECK (slot BETWEEN 1 AND 5),
 amount_inr int NOT NULL CHECK (amount_inr BETWEEN 20 AND 200 AND amount_inr % 20 = 0),
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','used','expired')),
 payment_link_id text UNIQUE,
 short_url text,
 created_at timestamptz NOT NULL DEFAULT now(),
 paid_at timestamptz
);
GRANT SELECT ON public.parking_sessions TO authenticated;
GRANT ALL ON public.parking_sessions TO service_role;
ALTER TABLE public.parking_sessions ENABLE ROW LEVEL SECURITY;
CREATE TABLE public.parking_operators (user_id uuid PRIMARY KEY);
GRANT SELECT ON public.parking_operators TO authenticated;
GRANT ALL ON public.parking_operators TO service_role;
ALTER TABLE public.parking_operators ENABLE ROW LEVEL SECURITY;
CREATE POLICY operator_self_read ON public.parking_operators FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY operators_read_sessions ON public.parking_sessions FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.parking_operators WHERE user_id = auth.uid()));
CREATE INDEX parking_sessions_paid_at_idx ON public.parking_sessions (paid_at);
CREATE INDEX parking_sessions_created_at_idx ON public.parking_sessions (created_at DESC);
ALTER PUBLICATION supabase_realtime ADD TABLE public.parking_sessions;
CREATE FUNCTION public.consume_parking_session(p_id uuid) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE current_session public.parking_sessions%ROWTYPE;
BEGIN
 SELECT * INTO current_session FROM public.parking_sessions WHERE id = p_id FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF current_session.status = 'paid' THEN
  UPDATE public.parking_sessions SET status = 'used' WHERE id = p_id;
  RETURN 'paid';
 END IF;
 IF current_session.status = 'pending' AND current_session.created_at + interval '15 minutes' <= now() THEN
  UPDATE public.parking_sessions SET status = 'expired' WHERE id = p_id;
  RETURN 'expired';
 END IF;
 RETURN current_session.status;
END;
$$;
REVOKE ALL ON FUNCTION public.consume_parking_session(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_parking_session(uuid) TO service_role;
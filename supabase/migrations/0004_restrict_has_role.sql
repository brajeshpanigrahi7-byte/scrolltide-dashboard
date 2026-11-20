-- Restrict has_role RPC so it only checks the caller's own role.
-- Prevents enumeration of admin user IDs by checking auth.uid().
CREATE OR REPLACE FUNCTION public.has_role(required_role text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER STABLE
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND role = required_role
  );
END;
$$;

-- Overload for backwards compatibility that strictly requires user_uuid = auth.uid()
-- Raises an exception if an authenticated caller attempts to enumerate other users
CREATE OR REPLACE FUNCTION public.has_role(user_uuid uuid, required_role text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER STABLE
AS $$
BEGIN
  IF user_uuid IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Access denied: Cannot query role for other users';
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND role = required_role
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.has_role(text) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, text) TO authenticated, anon;

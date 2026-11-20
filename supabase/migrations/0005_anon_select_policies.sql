-- Allow anonymous read-only access to device heartbeat and slot availability
CREATE POLICY IF NOT EXISTS anon_select_devices ON public.devices
  FOR SELECT TO anon USING (true);
CREATE POLICY IF NOT EXISTS anon_select_slots ON public.slots
  FOR SELECT TO anon USING (true);
CREATE POLICY IF NOT EXISTS anon_select_device_telemetry ON public.device_telemetry
  FOR SELECT TO anon USING (true);
CREATE POLICY IF NOT EXISTS anon_select_settings ON public.settings
  FOR SELECT TO anon USING (true);

-- Ensure writes remain blocked
REVOKE INSERT, UPDATE, DELETE ON public.devices FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.slots FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.device_telemetry FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.settings FROM anon;

import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/api/public/create-session")({ server: { handlers: { POST: async ({ request }) => {
  const { deviceSession } = await import("@/lib/parking/device-api.server");
  return deviceSession(request);
} } } });

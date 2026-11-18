import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/api/public/extend-session")({ server: { handlers: { POST: async ({ request }) => {
  const { extendSession } = await import("@/lib/parking/driver-api.server");
  return extendSession(request);
} } } });

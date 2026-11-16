import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/api/public/session-status")({
  server: { handlers: { GET: async ({ request }) => {
    const { sessionPublic } = await import("@/lib/parking/driver-api.server");
    return sessionPublic(request);
  } } },
});

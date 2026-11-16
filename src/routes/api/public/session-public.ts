import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/api/public/session-public")({
  server: { handlers: {
    GET: async ({ request }) => (await import("@/lib/parking/driver-api.server")).sessionPublic(request),
    OPTIONS: async () => (await import("@/lib/parking/driver-api.server")).publicOptions(),
  } },
});

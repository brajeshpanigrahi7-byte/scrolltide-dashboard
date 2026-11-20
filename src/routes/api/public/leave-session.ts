import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/api/public/leave-session")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        (await import("@/lib/parking/driver-api.server")).leaveSession(request),
      OPTIONS: async () => (await import("@/lib/parking/driver-api.server")).publicOptions(),
    },
  },
});

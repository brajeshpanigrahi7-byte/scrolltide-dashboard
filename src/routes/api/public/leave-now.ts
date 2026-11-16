import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/leave-now")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { leaveNow } = await import("@/lib/parking/driver-api.server");
        return leaveNow(request);
      },
    },
  },
});

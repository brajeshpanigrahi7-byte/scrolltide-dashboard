import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/device-health")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { deviceHealth } = await import("@/lib/parking/device-api.server");
        return deviceHealth(request);
      },
    },
  },
});

import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/api/public/device-event")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { deviceEvent } = await import("@/lib/parking/device-api.server");
        return deviceEvent(request);
      },
    },
  },
});

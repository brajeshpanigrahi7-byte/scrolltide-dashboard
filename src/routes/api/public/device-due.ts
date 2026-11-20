import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/api/public/device-due")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { deviceDue } = await import("@/lib/parking/device-api.server");
        return deviceDue(request);
      },
    },
  },
});

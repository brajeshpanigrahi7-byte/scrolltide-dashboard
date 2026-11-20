import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/clean-stale")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { requireDeviceKey, cleanStaleSessions } =
          await import("@/lib/parking/device-api.server");
        const denied = requireDeviceKey(request);
        if (denied) return denied;

        const res = await cleanStaleSessions();
        return new Response(JSON.stringify(res), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        });
      },
    },
  },
});

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/clean-stale")({
  server: {
    handlers: {
      POST: async () => {
        const { cleanStaleSessions } = await import("@/lib/parking/device-api.server");
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

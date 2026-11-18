import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/extend-session")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        (await import("@/lib/parking/driver-api.server")).createOrder(request),
      OPTIONS: async () =>
        (await import("@/lib/parking/driver-api.server")).publicOptions(),
    },
  },
});

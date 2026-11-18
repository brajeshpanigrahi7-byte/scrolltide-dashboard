import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/verify-payment")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { verifyPayment } = await import("@/lib/parking/driver-api.server");
        return verifyPayment(request);
      },
    },
  },
});

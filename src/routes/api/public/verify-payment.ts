import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/verify-payment")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Locked down: verifyPayment verifies cryptographic signatures only.
        // It does NOT activate parking access or open barriers; access is
        // triggered exclusively via verified server-side webhooks.
        const { verifyPayment } = await import("@/lib/parking/driver-api.server");
        return verifyPayment(request);
      },
    },
  },
});

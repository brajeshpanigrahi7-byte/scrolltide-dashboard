import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/test-payment")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { createTestPayment } = await import("@/lib/parking/test-payment.server");
        return createTestPayment(request);
      },
    },
  },
});

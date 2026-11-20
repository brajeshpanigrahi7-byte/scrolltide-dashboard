import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/stripe-webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { stripeWebhook } = await import("@/lib/parking/payment-api.server");
        return stripeWebhook(request);
      },
    },
  },
});

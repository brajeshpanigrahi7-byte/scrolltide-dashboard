import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/api/public/razorpay-webhook")({ server: { handlers: { POST: async ({ request }) => {
  const { razorpayWebhook } = await import("@/lib/parking/payment-api.server");
  return razorpayWebhook(request);
} } } });

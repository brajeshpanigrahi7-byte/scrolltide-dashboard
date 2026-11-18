import { createFileRoute } from "@tanstack/react-router";
<<<<<<< HEAD

export const Route = createFileRoute("/api/public/verify-payment")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { verifyPayment } = await import("@/lib/parking/driver-api.server");
        return verifyPayment(request);
      },
    },
  },
=======
export const Route = createFileRoute("/api/public/verify-payment")({
  server: { handlers: {
    POST: async ({ request }) => (await import("@/lib/parking/driver-api.server")).verifyPayment(request),
    OPTIONS: async () => (await import("@/lib/parking/driver-api.server")).publicOptions(),
  } },
>>>>>>> origin/main
});

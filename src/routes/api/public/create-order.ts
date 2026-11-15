import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/api/public/create-order")({ server: { handlers: { POST: async ({ request }) => {
  const { createOrder } = await import("@/lib/parking/driver-api.server");
  return createOrder(request);
} } } });

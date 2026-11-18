import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/api/public/session-status")({ server: { handlers: { GET: async ({ request }) => {
  const { sessionStatus } = await import("@/lib/parking/payment-api.server");
  return sessionStatus(request);
} } } });

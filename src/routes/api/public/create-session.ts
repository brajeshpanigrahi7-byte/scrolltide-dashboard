import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/api/public/create-session")({ server: { handlers: { POST: async ({ request }) => {
  const { createSession } = await import("@/lib/parking/payment-api.server");
  return createSession(request);
} } } });
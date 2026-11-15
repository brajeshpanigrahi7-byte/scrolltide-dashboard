import { createFileRoute } from "@tanstack/react-router";
export const Route = createFileRoute("/api/public/device-poll")({ server: { handlers: { GET: async ({ request }) => {
  const { devicePoll } = await import("@/lib/parking/device-api.server");
  return devicePoll(request);
} } } });

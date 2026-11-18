import { createFileRoute } from "@tanstack/react-router";
<<<<<<< HEAD

export const Route = createFileRoute("/api/public/session-public")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { sessionPublic } = await import("@/lib/parking/driver-api.server");
        return sessionPublic(request);
      },
    },
  },
=======
export const Route = createFileRoute("/api/public/session-public")({
  server: { handlers: {
    GET: async ({ request }) => (await import("@/lib/parking/driver-api.server")).sessionPublic(request),
    OPTIONS: async () => (await import("@/lib/parking/driver-api.server")).publicOptions(),
  } },
>>>>>>> origin/main
});

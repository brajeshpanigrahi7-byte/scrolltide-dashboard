import { createFileRoute } from "@tanstack/react-router";
import { DriverPaymentView } from "@/components/parking/DriverPaymentView";

export const Route = createFileRoute("/p/$code")({
  head: () => ({
    meta: [
      { title: "ParkSense — Driver Payment" },
      { name: "viewport", content: "width=device-width, initial-scale=1, maximum-scale=1" },
    ],
    scripts: [
      {
        src: "https://checkout.razorpay.com/v1/checkout.js",
        async: true,
      },
    ],
  }),
  component: PCodeRoute,
});

function PCodeRoute() {
  const { code } = Route.useParams();
  return <DriverPaymentView code={code} />;
}

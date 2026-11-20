import { createFileRoute, redirect } from "@tanstack/react-router";
import { DriverPaymentView } from "@/components/parking/DriverPaymentView";

export const Route = createFileRoute("/pay/")({
  validateSearch: (search: Record<string, unknown>) => ({
    code: typeof search.code === "string" ? search.code : "",
  }),
  beforeLoad: ({ search }) => {
    if (search.code) {
      throw redirect({
        to: "/pay/$code",
        params: { code: search.code },
      });
    }
  },
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
  component: PayIndexRoute,
});

function PayIndexRoute() {
  const { code } = Route.useSearch();
  if (!code) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center p-4">
        <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-6 text-center space-y-3">
          <h1 className="text-base font-semibold text-slate-200">ParkSense Driver Payment</h1>
          <p className="text-xs text-slate-400">
            Please scan the QR code at your parking gate or slot to view and pay for your parking session.
          </p>
        </div>
      </div>
    );
  }
  return <DriverPaymentView code={code} />;
}

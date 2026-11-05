import { createFileRoute } from "@tanstack/react-router";
import { useParking } from "@/lib/parking/store";
import { DemoControls } from "@/components/dash/DemoControls";
import { ENTRY_STEPS, EXIT_STEPS, WorkflowColumn } from "@/components/dash/Workflow";

export const Route = createFileRoute("/workflow")({
  head: () => ({
    meta: [
      { title: "Workflow — ParkSense" },
      { name: "description", content: "Animated state diagram of the ESP32 entry and exit parking workflows." },
      { property: "og:title", content: "Workflow — ParkSense" },
      { property: "og:description", content: "Animated state diagram of the ESP32 entry and exit parking workflows." },
    ],
  }),
  component: Workflow,
});

function Workflow() {
  const { state: s } = useParking();
  return (
    <div className="space-y-5">
      <DemoControls />
      <div className="grid gap-5 lg:grid-cols-[3fr_2fr]">
        <WorkflowColumn title="Entry & parking workflow" steps={ENTRY_STEPS} current={s.entryStage} s={s} entry />
        <WorkflowColumn title="Exit workflow (independent)" steps={EXIT_STEPS} current={s.exitStage} s={s} />
      </div>
    </div>
  );
}

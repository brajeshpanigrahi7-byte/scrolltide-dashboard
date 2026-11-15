import { describe, expect, it } from "vitest";
import { createInitialState, occupancyPct, triggerExit, tick } from "@/lib/parking/engine";

const run = (s: ReturnType<typeof createInitialState>, from: number, ms: number, cm: number) => {
  for (let t = from + 100; t <= from + ms; t += 100) s = tick({ ...s, distanceCm: cm }, t);
  return s;
};

describe("parking firmware rules", () => {
  it("reserves the first free slot for 60 s after 5 readings under 15 cm", () => {
    let s = createInitialState(0);
    s.slots[0]!.status = "OCCUPIED"; s.slots[0]!.irRaw = true;
    s = run(s, 0, 500, 8);
    expect(s.slots[1]!.status).toBe("RESERVED");
    expect(s.slots[1]!.reservedUntil).toBe(500 + 60_000);
    expect(s.entryServo).toBe(90);
  });

  it("shows PARKING FULL and keeps gate closed when no slot is free", () => {
    let s = createInitialState(0);
    s.slots.forEach((x) => { x.status = "OCCUPIED"; x.irRaw = true; });
    s = run(s, 0, 500, 8);
    expect(s.entryPhase).toBe("FULL");
    expect(s.entryServo).toBe(0);
  });

  it("occupancy excludes reserved slots", () => {
    const s = createInitialState(0);
    s.slots[0]!.status = "OCCUPIED"; s.slots[1]!.status = "RESERVED";
    expect(occupancyPct(s)).toBe(20);
  });

  it("IR needs 2 s stable before OCCUPIED", () => {
    let s = createInitialState(0);
    s.slots[2]!.irRaw = true;
    s = run(s, 0, 1900, 100);
    expect(s.slots[2]!.status).toBe("FREE");
    s = run(s, 1900, 300, 100);
    expect(s.slots[2]!.status).toBe("OCCUPIED");
  });

  it("triggerExit opens exit gate for 60 s", () => {
    let s = triggerExit(createInitialState(0), 1000);
    s = run(s, 1000, 59900, 100);
    expect(s.exitServo).toBe(90);
    s = run(s, 60900, 200, 100);
    expect(s.exitServo).toBe(0);
  });
});

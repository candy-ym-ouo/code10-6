import { describe, expect, it } from "vitest";
import {
  calculateSessionDuration,
  canTransitionSession,
  clampAnnotationRange,
  describeMissingReview,
  isGoalProgressValid,
  validateAnnotationRange,
} from "../src/index.js";

describe("session state machine", () => {
  it("allows the required completion transition", () => {
    expect(canTransitionSession("IN_REVIEW", "COMPLETED")).toBe(true);
    expect(canTransitionSession("DRAFT", "COMPLETED")).toBe(false);
  });
});

describe("annotation range", () => {
  it("rejects ranges under 100ms and outside media", () => {
    expect(validateAnnotationRange(100, 150, 1000)).toMatchObject({ ok: false });
    expect(validateAnnotationRange(900, 1100, 1000)).toMatchObject({ ok: false });
    expect(validateAnnotationRange(100, 250, 1000)).toEqual({ ok: true });
  });
});

describe("clamp annotation range while dragging", () => {
  it("keeps the opposite edge and enforces the minimum 100ms span for edge drags", () => {
    expect(clampAnnotationRange(150, 200, 1000, 100, "start")).toEqual({ startMs: 100, endMs: 200 });
    expect(clampAnnotationRange(100, 50, 1000, 100, "end")).toEqual({ startMs: 100, endMs: 200 });
  });

  it("pins edge drags inside the media bounds", () => {
    expect(clampAnnotationRange(950, 1450, 1000, 100, "start")).toEqual({ startMs: 900, endMs: 1000 });
    expect(clampAnnotationRange(950, 1450, 1000, 100, "end")).toEqual({ startMs: 900, endMs: 1000 });
    expect(clampAnnotationRange(-40, 60, 1000, 100, "start")).toEqual({ startMs: 0, endMs: 100 });
  });

  it("slides a moved range back without changing its width", () => {
    expect(clampAnnotationRange(1100, 1600, 1000, 100, "move")).toEqual({ startMs: 500, endMs: 1000 });
    expect(clampAnnotationRange(-100, 400, 1000, 100, "move")).toEqual({ startMs: 0, endMs: 500 });
  });

  it("normalizes without a known media duration", () => {
    expect(clampAnnotationRange(100, 50, null)).toEqual({ startMs: 100, endMs: 200 });
  });
});

describe("review completion", () => {
  it("returns every missing item instead of a generic failure", () => {
    expect(
      describeMissingReview({
        readyMediaCount: 0,
        annotationCount: 0,
        noIssues: false,
        nextFocus: "",
        openGoalCount: 0,
        newGoalCount: 0,
        progressUpdateCount: 0,
      }),
    ).toHaveLength(4);
  });
});

describe("goal values", () => {
  it("suggests achieved only when actual reaches target", () => {
    expect(isGoalProgressValid(90, 88)).toBe(true);
    expect(isGoalProgressValid(87, 88)).toBe(false);
  });

  it("sums only valid media durations", () => {
    expect(calculateSessionDuration([1000, null, 2500, -1])).toBe(3500);
  });
});

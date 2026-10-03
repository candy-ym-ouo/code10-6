import { describe, expect, it } from "vitest";
import {
  annotationBatchDeleteSchema,
  annotationBatchUpdateSchema,
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

describe("drag range clamping", () => {
  it("keeps a minimum 100ms span and snaps to 10ms", () => {
    expect(clampAnnotationRange(100, 150, 1000, "move")).toEqual({ startMs: 100, endMs: 200 });
  });

  it("clamps moving the whole region back inside the media duration", () => {
    expect(clampAnnotationRange(950, 1100, 1000, "move")).toEqual({ startMs: 900, endMs: 1000 });
  });

  it("prevents the start handle from overtaking the end handle", () => {
    expect(clampAnnotationRange(900, 500, 1000, "start")).toEqual({ startMs: 400, endMs: 500 });
  });

  it("extends the end handle while keeping at least 100ms and inside media", () => {
    expect(clampAnnotationRange(500, 540, 1000, "end")).toEqual({ startMs: 500, endMs: 600 });
    expect(clampAnnotationRange(950, 1300, 1000, "end")).toEqual({ startMs: 900, endMs: 1000 });
  });

  it("never returns a negative start and supports unknown duration", () => {
    const moved = clampAnnotationRange(-300, -250, null, "move");
    expect(moved.startMs).toBe(0);
    expect(moved.endMs - moved.startMs).toBeGreaterThanOrEqual(100);
  });
});

describe("annotation batch schemas", () => {
  const id = "11111111-1111-4111-8111-111111111111";

  it("accepts a batch update with at least one field", () => {
    expect(annotationBatchUpdateSchema.parse({ ids: [id], severity: 2 })).toMatchObject({ severity: 2 });
    expect(annotationBatchUpdateSchema.parse({ ids: [id], type: "EMOTION" })).toMatchObject({ type: "EMOTION" });
  });

  it("rejects an empty patch or empty id list", () => {
    expect(annotationBatchUpdateSchema.safeParse({ ids: [id] }).success).toBe(false);
    expect(annotationBatchDeleteSchema.safeParse({ ids: [] }).success).toBe(false);
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

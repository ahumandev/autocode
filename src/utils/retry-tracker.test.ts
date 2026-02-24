import { describe, test, expect, beforeEach } from "bun:test";
import { trackFailure, getStatus, resetSession } from "./retry-tracker";

describe("retry-tracker", () => {
  beforeEach(() => {
    resetSession("session-1");
    resetSession("session-2");
  });

  test("first failure returns retriesLeft=4, shouldAbort=false", () => {
    const result = trackFailure("session-1", "tool-a");
    expect(result.retriesLeft).toBe(4);
    expect(result.shouldAbort).toBe(false);
  });

  test("multiple failures of same tool increments counter correctly", () => {
    const r1 = trackFailure("session-1", "tool-a");
    expect(r1.retriesLeft).toBe(4);

    const r2 = trackFailure("session-1", "tool-a");
    expect(r2.retriesLeft).toBe(3);

    const r3 = trackFailure("session-1", "tool-a");
    expect(r3.retriesLeft).toBe(2);

    const r4 = trackFailure("session-1", "tool-a");
    expect(r4.retriesLeft).toBe(1);

    const r5 = trackFailure("session-1", "tool-a");
    expect(r5.retriesLeft).toBe(0);
  });

  test("fifth failure triggers abort when retriesLeft reaches 0", () => {
    trackFailure("session-1", "tool-a");
    trackFailure("session-1", "tool-a");
    trackFailure("session-1", "tool-a");
    trackFailure("session-1", "tool-a");

    const result = trackFailure("session-1", "tool-a");
    expect(result.retriesLeft).toBe(0);
    expect(result.shouldAbort).toBe(true);
  });

  test("different tool resets counter", () => {
    trackFailure("session-1", "tool-a");
    trackFailure("session-1", "tool-a");

    const result = trackFailure("session-1", "tool-b");
    expect(result.retriesLeft).toBe(4);
    expect(result.shouldAbort).toBe(false);
  });

  test("getStatus returns correct values without changing state", () => {
    trackFailure("session-1", "tool-a");
    trackFailure("session-1", "tool-a");

    const status1 = getStatus("session-1", "tool-a");
    expect(status1.retriesLeft).toBe(3);
    expect(status1.shouldAbort).toBe(false);

    const status2 = getStatus("session-1", "tool-a");
    expect(status2.retriesLeft).toBe(3);
    expect(status2.shouldAbort).toBe(false);
  });

  test("getStatus returns full retries for untracked tool", () => {
    trackFailure("session-1", "tool-a");

    const status = getStatus("session-1", "tool-b");
    expect(status.retriesLeft).toBe(5);
    expect(status.shouldAbort).toBe(false);
  });

  test("resetSession clears state", () => {
    trackFailure("session-1", "tool-a");
    trackFailure("session-1", "tool-a");

    resetSession("session-1");

    const result = trackFailure("session-1", "tool-a");
    expect(result.retriesLeft).toBe(4);
    expect(result.shouldAbort).toBe(false);
  });

  test("multiple sessions are isolated", () => {
    trackFailure("session-1", "tool-a");
    trackFailure("session-1", "tool-a");

    trackFailure("session-2", "tool-a");

    const status1 = getStatus("session-1", "tool-a");
    expect(status1.retriesLeft).toBe(3);

    const status2 = getStatus("session-2", "tool-a");
    expect(status2.retriesLeft).toBe(4);
  });
});

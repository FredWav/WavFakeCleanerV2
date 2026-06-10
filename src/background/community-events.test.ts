import { describe, it, expect, vi, beforeEach } from "vitest";
import { chromeMock } from "../test/setup";

// telemetry.ts (imported by community-events) reads settings from ./storage —
// keep it quiet and keep idb out of node.
vi.mock("./storage", () => ({
  getSettings: vi.fn(async () => ({ telemetry: false })),
  getLicense: vi.fn(),
}));

import {
  recordCommunityEvent,
  recordReplaySummary,
  setTokenStatus,
  getCommunityStatusSnapshot,
} from "./community-events";

beforeEach(() => {
  // Safety net: if telemetry ever fires (e.g. default flips), no real network.
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
});

describe("recordCommunityEvent counters", () => {
  it("tallies sent contributions and marks the token ok", async () => {
    await recordCommunityEvent({ kind: "vote_sent" });
    await recordCommunityEvent({ kind: "sightings_sent", count: 12 });

    const status = await getCommunityStatusSnapshot();
    expect(status.sent).toBe(13);
    expect(status.tokenStatus).toBe("ok");
    expect(status.updatedAt).toBeGreaterThan(0);
  });

  it("tallies enqueued contributions", async () => {
    await recordCommunityEvent({ kind: "vote_enqueued" });
    await recordCommunityEvent({ kind: "vote_enqueued" });

    expect((await getCommunityStatusSnapshot()).enqueued).toBe(2);
  });

  it("tallies drops by reason and tracks the last drop reason", async () => {
    await recordCommunityEvent({ kind: "vote_dropped", reason: "http_403" });
    await recordCommunityEvent({ kind: "vote_dropped", reason: "http_403" });
    await recordCommunityEvent({ kind: "sightings_dropped", reason: "expired", count: 5, stage: "replay" });

    const status = await getCommunityStatusSnapshot();
    expect(status.dropped).toBe(7);
    expect(status.droppedByReason).toEqual({ http_403: 2, expired: 5 });
    expect(status.lastDropReason).toBe("expired");
  });

  it("counts queue overflow as dropped with reason overflow", async () => {
    await recordCommunityEvent({ kind: "queue_overflow", count: 3 });

    const status = await getCommunityStatusSnapshot();
    expect(status.dropped).toBe(3);
    expect(status.droppedByReason.overflow).toBe(3);
  });

  it("stores the last replay snapshot", async () => {
    await recordReplaySummary({ replayed: 4, dropped: 1, remaining: 2 });

    const status = await getCommunityStatusSnapshot();
    expect(status.lastReplay).toMatchObject({ replayed: 4, dropped: 1, remaining: 2 });
    expect(status.lastReplay?.ts).toBeGreaterThan(0);
  });

  it("marks the token invalid (and stamps the check time) on token_invalid", async () => {
    await recordCommunityEvent({ kind: "token_invalid", reason: "vote_403" });

    const status = await getCommunityStatusSnapshot();
    expect(status.tokenStatus).toBe("invalid");
    expect(status.tokenCheckedAt).toBeGreaterThan(0);
  });
});

describe("setTokenStatus", () => {
  it("stamps tokenCheckedAt for conclusive results only", async () => {
    await setTokenStatus("ok");
    const afterOk = await getCommunityStatusSnapshot();
    expect(afterOk.tokenStatus).toBe("ok");
    expect(afterOk.tokenCheckedAt).toBeGreaterThan(0);
  });

  it("does not stamp tokenCheckedAt for unknown", async () => {
    await setTokenStatus("unknown");
    const status = await getCommunityStatusSnapshot();
    expect(status.tokenStatus).toBe("unknown");
    expect(status.tokenCheckedAt).toBeNull();
  });
});

describe("robustness", () => {
  it("never throws when the status write fails, and keeps working after", async () => {
    chromeMock.failNextSet();
    await expect(recordCommunityEvent({ kind: "vote_sent" })).resolves.toBeUndefined();

    // The failed write lost that increment, but the funnel still works.
    await recordCommunityEvent({ kind: "vote_sent" });
    expect((await getCommunityStatusSnapshot()).sent).toBe(1);
  });
});

describe("LogConsole broadcasts", () => {
  function communityLogs() {
    return chromeMock.sendMessage.mock.calls
      .map((c) => c[0] as { type: string; payload?: { category?: string; level?: string } })
      .filter((m) => m?.type === "LOG_EVENT" && m.payload?.category === "community");
  }

  it("broadcasts a WARNING for submit-stage drops", async () => {
    await recordCommunityEvent({ kind: "vote_dropped", reason: "quota", stage: "submit" });

    const logs = communityLogs();
    expect(logs.length).toBe(1);
    expect(logs[0].payload?.level).toBe("WARNING");
  });

  it("stays quiet for replay-stage drops (the summary line covers them)", async () => {
    await recordCommunityEvent({ kind: "vote_dropped", reason: "network", stage: "replay" });
    expect(communityLogs().length).toBe(0);

    // …but an active replay summary does broadcast one line.
    await recordReplaySummary({ replayed: 2, dropped: 1, remaining: 0 });
    expect(communityLogs().length).toBe(1);
    expect(communityLogs()[0].payload?.level).toBe("INFO");
  });
});

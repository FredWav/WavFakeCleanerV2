import { describe, it, expect, vi, beforeEach } from "vitest";
import { chromeMock } from "../test/setup";

// Keep idb (IndexedDB) out of the node test environment, and keep telemetry
// quiet (getSettings → telemetry off).
vi.mock("./storage", () => ({
  getLicense: vi.fn(),
  getSettings: vi.fn(async () => ({ telemetry: false })),
}));

import {
  submitVote,
  reportSightings,
  processCommunityQueue,
  checkSightings,
  checkTokenHealth,
  getCommunityStatus,
  shouldRetry,
  QUEUE_MAX_ENTRIES,
  QUEUE_MAX_ATTEMPTS,
  QUEUE_TTL_MS,
} from "./community";
import { COMMUNITY_STATUS_KEY, type StoredCommunityStatus } from "./community-events";
import { getLicense } from "./storage";
import type { LicenseInfo } from "@shared/types";

const QUEUE_KEY = "wfc_community_queue";

// Clearly-fake token: tests never reach the real Worker (fetch is stubbed),
// and this string can't be mistaken for a licence key.
const TEST_TOKEN = "test-community-token";

const LICENSED: LicenseInfo = {
  active: true,
  key: TEST_TOKEN,
  activatedAt: 1,
  communityToken: TEST_TOKEN,
  recoveryToken: TEST_TOKEN,
};

async function sha256Hex(str: string): Promise<string> {
  const data = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function jsonRes(status: number, body: unknown = { ok: true }): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface QueuedVoteShape {
  kind: "vote";
  body: { targetHash: string; communityToken: string; verdict: string; score: number; ts: number; nonce: string };
  attempts: number;
  enqueuedAt: number;
}

function voteItem(over: Partial<QueuedVoteShape> = {}): QueuedVoteShape {
  return {
    kind: "vote",
    body: {
      targetHash: "ab".repeat(32),
      communityToken: TEST_TOKEN,
      verdict: "fake",
      score: 95,
      ts: 1000,
      nonce: "00".repeat(8),
    },
    attempts: 0,
    enqueuedAt: Date.now(),
    ...over,
  };
}

async function getQueue(): Promise<QueuedVoteShape[]> {
  const result = await chromeMock.chrome.storage.local.get(QUEUE_KEY);
  return (result[QUEUE_KEY] as QueuedVoteShape[]) ?? [];
}

async function getStatus(): Promise<StoredCommunityStatus> {
  const result = await chromeMock.chrome.storage.local.get(COMMUNITY_STATUS_KEY);
  return (result[COMMUNITY_STATUS_KEY] as StoredCommunityStatus) ?? ({} as StoredCommunityStatus);
}

function lastFetchBody(): Record<string, unknown> {
  const calls = fetchMock.mock.calls;
  const init = calls[calls.length - 1][1] as RequestInit;
  return JSON.parse(init.body as string);
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(getLicense).mockResolvedValue({ ...LICENSED });
});

// ── shouldRetry matrix ──

describe("shouldRetry", () => {
  it("retries network errors, 5xx and 429; drops other 4xx", () => {
    expect(shouldRetry(null)).toBe(true);   // network error
    expect(shouldRetry(500)).toBe(true);
    expect(shouldRetry(502)).toBe(true);
    expect(shouldRetry(503)).toBe(true);
    expect(shouldRetry(429)).toBe(true);    // rate-limit window resets hourly
    expect(shouldRetry(400)).toBe(false);
    expect(shouldRetry(401)).toBe(false);
    expect(shouldRetry(403)).toBe(false);
    expect(shouldRetry(404)).toBe(false);
    expect(shouldRetry(200)).toBe(false);
  });
});

// ── submitVote ──

describe("submitVote", () => {
  it("POSTs the hashed username with fresh ts and 16-hex nonce on success", async () => {
    fetchMock.mockResolvedValue(jsonRes(200));
    const before = Date.now();

    await submitVote("SomeUser", "fake", 88);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = lastFetchBody();
    expect(body.targetHash).toBe(await sha256Hex("someuser")); // lowercased
    expect(body.communityToken).toBe(TEST_TOKEN);
    expect(body.verdict).toBe("fake");
    expect(body.score).toBe(88);
    expect(body.ts as number).toBeGreaterThanOrEqual(before);
    expect(body.nonce).toMatch(/^[0-9a-f]{32}$/);

    expect(await getQueue()).toHaveLength(0);
    const status = await getStatus();
    expect(status.sent).toBe(1);
    expect(status.tokenStatus).toBe("ok"); // a successful submit proves the token
  });

  it("does nothing without an active licence", async () => {
    vi.mocked(getLicense).mockResolvedValue({
      active: false, key: null, activatedAt: null, communityToken: null,
    });
    await submitVote("user", "fake", 90);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing for owner licences (no Worker-issued token)", async () => {
    vi.mocked(getLicense).mockResolvedValue({
      active: true, key: "owner-fred", activatedAt: 1, communityToken: null,
    });
    await submitVote("user", "fake", 90);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("enqueues on network error", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    await submitVote("user", "fake", 90);

    const queue = await getQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0].attempts).toBe(0);
    expect((await getStatus()).enqueued).toBe(1);
  });

  it("enqueues on 500", async () => {
    fetchMock.mockResolvedValue(jsonRes(500, { error: "boom" }));
    await submitVote("user", "fake", 90);
    expect(await getQueue()).toHaveLength(1);
  });

  it("drops on 403, records the reason, and triggers a token health check", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonRes(403, { error: "invalid_token" })) // the vote
      .mockResolvedValue(jsonRes(200, { valid: false }));              // /token-check

    await submitVote("user", "fake", 90);

    expect(await getQueue()).toHaveLength(0);
    // The health check is fire-and-forget — wait for it to land.
    await vi.waitFor(async () => {
      const status = await getStatus();
      expect(status.tokenStatus).toBe("invalid");
    });
    const status = await getStatus();
    expect(status.dropped).toBe(1);
    expect(status.droppedByReason.http_403).toBe(1);
    expect(status.lastDropReason).toBe("http_403");
  });

  it("deduplicates queued votes for the same target (last vote wins)", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));

    await submitVote("target", "fake", 90);
    await submitVote("target", "ok", 10);

    const queue = await getQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0].body.verdict).toBe("ok");
    expect(queue[0].body.score).toBe(10);
  });

  it("drops with reason quota when the queue write fails", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    chromeMock.failNextSet();

    await submitVote("quotauser", "fake", 80);

    expect(await getQueue()).toHaveLength(0);
    const status = await getStatus();
    expect(status.droppedByReason.quota).toBe(1);
    expect(status.enqueued).toBe(0); // never counted as queued
  });

  it("trims the oldest entry and counts the overflow at the queue cap", async () => {
    const old = Array.from({ length: QUEUE_MAX_ENTRIES }, (_, i) =>
      voteItem({ body: { ...voteItem().body, targetHash: String(i).padStart(64, "0") } }),
    );
    await chromeMock.chrome.storage.local.set({ [QUEUE_KEY]: old });

    fetchMock.mockRejectedValue(new Error("offline"));
    await submitVote("newuser", "fake", 90);

    const queue = await getQueue();
    expect(queue).toHaveLength(QUEUE_MAX_ENTRIES);
    expect(queue[0].body.targetHash).toBe(String(1).padStart(64, "0")); // oldest gone
    expect(queue[queue.length - 1].body.targetHash).toBe(await sha256Hex("newuser"));
    const status = await getStatus();
    expect(status.droppedByReason.overflow).toBe(1);
  });
});

// ── reportSightings ──

describe("reportSightings", () => {
  it("merges queued sighting batches while they fit the Worker cap", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));

    await reportSightings(["alice", "bob"]);
    await reportSightings(["bob", "carol"]);

    const queue = await getQueue();
    expect(queue).toHaveLength(1);
    const hashes = (queue[0].body as unknown as { targetHashes: string[] }).targetHashes;
    expect(hashes).toHaveLength(3); // alice, bob, carol — bob deduped
    expect(queue[0].attempts).toBe(0);
  });

  it("does nothing for an empty list", async () => {
    await reportSightings([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── processCommunityQueue ──

describe("processCommunityQueue", () => {
  it("replays with a REFRESHED ts and nonce (regression pin for e7190ca)", async () => {
    const original = voteItem();
    await chromeMock.chrome.storage.local.set({ [QUEUE_KEY]: [original] });
    fetchMock.mockResolvedValue(jsonRes(200));
    const before = Date.now();

    const summary = await processCommunityQueue();

    expect(summary).toEqual({ replayed: 1, dropped: 0, remaining: 0 });
    const body = lastFetchBody();
    // The Worker rejects ts older than 5 min and replayed nonces — both MUST
    // be regenerated, otherwise every replay 4xx's and the item is lost.
    expect(body.ts as number).toBeGreaterThanOrEqual(before);
    expect(body.ts).not.toBe(original.body.ts);
    expect(body.nonce).not.toBe(original.body.nonce);
    expect(body.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(await getQueue()).toHaveLength(0);
    expect((await getStatus()).sent).toBe(1);
  });

  it("keeps items with attempts+1 on 5xx", async () => {
    await chromeMock.chrome.storage.local.set({ [QUEUE_KEY]: [voteItem()] });
    fetchMock.mockResolvedValue(jsonRes(500, { error: "boom" }));

    const summary = await processCommunityQueue();

    expect(summary).toEqual({ replayed: 0, dropped: 0, remaining: 1 });
    const queue = await getQueue();
    expect(queue[0].attempts).toBe(1);
  });

  it("drops after the attempt cap with reason max_attempts", async () => {
    await chromeMock.chrome.storage.local.set({
      [QUEUE_KEY]: [voteItem({ attempts: QUEUE_MAX_ATTEMPTS - 1 })],
    });
    fetchMock.mockResolvedValue(jsonRes(500, { error: "boom" }));

    const summary = await processCommunityQueue();

    expect(summary).toEqual({ replayed: 0, dropped: 1, remaining: 0 });
    expect((await getStatus()).droppedByReason.max_attempts).toBe(1);
  });

  it("drops non-retryable 4xx with reason http_4xx", async () => {
    await chromeMock.chrome.storage.local.set({ [QUEUE_KEY]: [voteItem()] });
    fetchMock.mockResolvedValue(jsonRes(400, { error: "nonce_replayed" }));

    const summary = await processCommunityQueue();

    expect(summary.dropped).toBe(1);
    expect((await getStatus()).droppedByReason.http_4xx).toBe(1);
  });

  it("drops expired items without wasting a request", async () => {
    await chromeMock.chrome.storage.local.set({
      [QUEUE_KEY]: [voteItem({ enqueuedAt: Date.now() - QUEUE_TTL_MS - 60_000 })],
    });

    const summary = await processCommunityQueue();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(summary).toEqual({ replayed: 0, dropped: 1, remaining: 0 });
    expect((await getStatus()).droppedByReason.expired).toBe(1);
  });

  it("records the replay summary snapshot", async () => {
    await chromeMock.chrome.storage.local.set({ [QUEUE_KEY]: [voteItem()] });
    fetchMock.mockResolvedValue(jsonRes(200));

    await processCommunityQueue();

    const status = await getStatus();
    expect(status.lastReplay).toMatchObject({ replayed: 1, dropped: 0, remaining: 0 });
    expect(status.lastReplay?.ts).toBeGreaterThan(0);
  });

  it("is a no-op on an empty queue", async () => {
    const summary = await processCommunityQueue();
    expect(summary).toEqual({ replayed: 0, dropped: 0, remaining: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── checkTokenHealth ──

describe("checkTokenHealth", () => {
  it("returns ok and stamps tokenCheckedAt for a valid token", async () => {
    fetchMock.mockResolvedValue(jsonRes(200, { valid: true }));

    const result = await checkTokenHealth(true);

    expect(result).toBe("ok");
    const status = await getStatus();
    expect(status.tokenStatus).toBe("ok");
    expect(status.tokenCheckedAt).toBeGreaterThan(0);
  });

  it("returns invalid and records the event for a rejected token", async () => {
    fetchMock.mockResolvedValue(jsonRes(200, { valid: false }));

    const result = await checkTokenHealth(true);

    expect(result).toBe("invalid");
    expect((await getStatus()).tokenStatus).toBe("invalid");
  });

  it("does not erase a known status on network failure", async () => {
    await chromeMock.chrome.storage.local.set({
      [COMMUNITY_STATUS_KEY]: { tokenStatus: "ok", tokenCheckedAt: 1 },
    });
    fetchMock.mockRejectedValue(new Error("offline"));

    const result = await checkTokenHealth(true);

    expect(result).toBe("unknown");
    expect((await getStatus()).tokenStatus).toBe("ok"); // unchanged
  });

  it("skips the network entirely within the 24h lazy window", async () => {
    await chromeMock.chrome.storage.local.set({
      [COMMUNITY_STATUS_KEY]: { tokenStatus: "ok", tokenCheckedAt: Date.now() - 3_600_000 },
    });

    const result = await checkTokenHealth(false);

    expect(result).toBe("ok");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns unknown without fetching when there is no usable token", async () => {
    vi.mocked(getLicense).mockResolvedValue({
      active: true, key: "owner-fred", activatedAt: 1, communityToken: null,
    });
    expect(await checkTokenHealth(true)).toBe("unknown");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── checkSightings ──

describe("checkSightings", () => {
  it("maps hashed results back to usernames", async () => {
    const hash = await sha256Hex("suspect");
    fetchMock.mockResolvedValue(jsonRes(200, { results: { [hash]: 4 } }));

    const result = await checkSightings(["Suspect"]);

    expect(result.get("Suspect")).toBe(4);
  });

  it("returns an empty map and records lookup_failed on HTTP error", async () => {
    fetchMock.mockResolvedValue(jsonRes(503, { error: "down" }));

    const result = await checkSightings(["user"]);

    expect(result.size).toBe(0);
    // lookup failures don't touch counters, but they do stamp the status doc
    expect((await getStatus()).updatedAt).toBeGreaterThan(0);
  });

  it("returns an empty map on network error", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    const result = await checkSightings(["user"]);
    expect(result.size).toBe(0);
  });
});

// ── getCommunityStatus ──

describe("getCommunityStatus", () => {
  it("combines the stored snapshot with the live queue length", async () => {
    await chromeMock.chrome.storage.local.set({
      [QUEUE_KEY]: [voteItem(), voteItem({ body: { ...voteItem().body, targetHash: "cd".repeat(32) } })],
      [COMMUNITY_STATUS_KEY]: { sent: 7, tokenStatus: "ok" },
    });

    const status = await getCommunityStatus();

    expect(status.queueLength).toBe(2);
    expect(status.sent).toBe(7);
    expect(status.tokenStatus).toBe("ok");
    expect(status.droppedByReason).toEqual({}); // defaults merged in
  });
});

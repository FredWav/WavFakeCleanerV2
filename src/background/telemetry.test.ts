import { describe, it, expect, vi, beforeEach } from "vitest";
import "../test/setup";

vi.mock("./storage", () => ({
  getSettings: vi.fn(),
}));

import { reportTelemetry } from "./telemetry";
import { getSettings } from "./storage";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(getSettings).mockResolvedValue({ threadsUsername: "", scoreThreshold: 70, telemetry: true });
});

function lastPayload(): Record<string, unknown> {
  const calls = fetchMock.mock.calls;
  const init = calls[calls.length - 1][1] as RequestInit;
  return JSON.parse(init.body as string);
}

// NOTE: the throttle map is module-level state — each test uses its own
// category:errorCode key so tests stay independent within this file.

describe("reportTelemetry", () => {
  it("honors the opt-out", async () => {
    vi.mocked(getSettings).mockResolvedValue({ threadsUsername: "", scoreThreshold: 70, telemetry: false });
    await reportTelemetry({ category: "t1", errorCode: "optout" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the payload with a rounded numeric value", async () => {
    await reportTelemetry({ category: "t2", errorCode: "with_value", reason: "r", stage: "s", value: 3.7 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = lastPayload();
    expect(payload.category).toBe("t2");
    expect(payload.errorCode).toBe("with_value");
    expect(payload.reason).toBe("r");
    expect(payload.stage).toBe("s");
    expect(payload.value).toBe(4);
    expect(typeof payload.anonId).toBe("string");
    expect(payload.v).toBe("3.0.0"); // from the manifest mock
  });

  it("omits non-finite values", async () => {
    await reportTelemetry({ category: "t3", errorCode: "bad_value", value: Number.NaN });
    expect(lastPayload().value).toBeUndefined();
  });

  it("throttles repeated events per category:errorCode", async () => {
    for (let i = 0; i < 15; i++) {
      await reportTelemetry({ category: "t4", errorCode: "flood" });
    }
    expect(fetchMock).toHaveBeenCalledTimes(10); // client cap per hour window

    // A different key is not affected by the flooded one.
    await reportTelemetry({ category: "t4", errorCode: "other" });
    expect(fetchMock).toHaveBeenCalledTimes(11);
  });

  it("reuses the same anonymous ID across events", async () => {
    await reportTelemetry({ category: "t5", errorCode: "first" });
    const first = lastPayload().anonId;
    await reportTelemetry({ category: "t5", errorCode: "second" });
    expect(lastPayload().anonId).toBe(first);
  });
});

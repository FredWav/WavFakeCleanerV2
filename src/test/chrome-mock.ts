/**
 * In-memory mock of the chrome extension APIs used by the background modules.
 *
 * Coverage is deliberately minimal: storage.local/sync/session (Map-backed,
 * promise API), runtime.sendMessage/getManifest, and alarm stubs. The handle
 * exposes failNextSet() so tests can simulate a storage quota error on the
 * next write — the failure mode behind the "quota" drop reason.
 */
import { vi } from "vitest";

type StorageKey = string | string[] | Record<string, unknown> | undefined;

function createStorageArea(state: { failNextSet: boolean }) {
  const store = new Map<string, unknown>();

  const area = {
    get: vi.fn(async (key?: StorageKey): Promise<Record<string, unknown>> => {
      if (typeof key === "string") {
        return { [key]: store.has(key) ? structuredClone(store.get(key)) : undefined };
      }
      if (Array.isArray(key)) {
        const out: Record<string, unknown> = {};
        for (const k of key) out[k] = store.has(k) ? structuredClone(store.get(k)) : undefined;
        return out;
      }
      if (key && typeof key === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, fallback] of Object.entries(key)) {
          out[k] = store.has(k) ? structuredClone(store.get(k)) : fallback;
        }
        return out;
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of store) out[k] = structuredClone(v);
      return out;
    }),
    set: vi.fn(async (items: Record<string, unknown>): Promise<void> => {
      if (state.failNextSet) {
        state.failNextSet = false;
        throw new Error("QUOTA_BYTES quota exceeded");
      }
      for (const [k, v] of Object.entries(items)) store.set(k, structuredClone(v));
    }),
    remove: vi.fn(async (key: string | string[]): Promise<void> => {
      for (const k of Array.isArray(key) ? key : [key]) store.delete(k);
    }),
    clear: vi.fn(async (): Promise<void> => {
      store.clear();
    }),
  };

  return { area, store };
}

export function createChromeMock() {
  const state = { failNextSet: false };
  const local = createStorageArea(state);
  const sync = createStorageArea({ failNextSet: false });
  const session = createStorageArea({ failNextSet: false });

  const sendMessage = vi.fn(async (_message?: unknown): Promise<unknown> => undefined);
  const getManifest = vi.fn(() => ({ version: "3.0.0" }));

  const chrome = {
    storage: {
      local: local.area,
      sync: sync.area,
      session: session.area,
    },
    runtime: {
      sendMessage,
      getManifest,
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    alarms: {
      create: vi.fn(),
      clear: vi.fn(),
      onAlarm: { addListener: vi.fn() },
    },
  };

  return {
    chrome,
    sendMessage,
    /** Make the NEXT chrome.storage.local.set call throw (quota simulation). */
    failNextSet: () => {
      state.failNextSet = true;
    },
    reset: () => {
      local.store.clear();
      sync.store.clear();
      session.store.clear();
      state.failNextSet = false;
      sendMessage.mockClear();
    },
  };
}

export type ChromeMockHandle = ReturnType<typeof createChromeMock>;

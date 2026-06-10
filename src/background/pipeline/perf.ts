/**
 * Perf spans — measure where pipeline time actually goes, so optimization
 * targets the measured cost instead of guesses.
 *
 * Spans land in a ring buffer (200 entries) under chrome.storage.session:
 * inspectable from the SW devtools console, gone when the browser closes,
 * never synced, never sent anywhere. Only the coarse run summaries become
 * telemetry (category "perf", bucketed values — no precise fingerprintable
 * numbers).
 *
 * IMPORTANT: never wrap deliberate pacing waits (HumanPacer pauses, cooldowns,
 * anti-block sleeps from timings.ts) in a span — pacing is a feature, not a
 * cost to optimize. Wrap only the work segments between them.
 */

export const PERF_KEY = "wfc_perf_spans";
const RING_MAX = 200;

export interface PerfSpan {
  name: string;
  ms: number;
  ts: number;
  meta?: Record<string, number | string>;
}

let buffer: PerfSpan[] = [];
let loaded = false;
let writeChain: Promise<void> = Promise.resolve();

async function loadBuffer(): Promise<void> {
  if (loaded) return;
  try {
    const result = await chrome.storage.session.get(PERF_KEY);
    const stored = result[PERF_KEY];
    buffer = Array.isArray(stored) ? (stored as PerfSpan[]) : [];
  } catch {
    buffer = [];
  }
  loaded = true;
}

function persist(): void {
  writeChain = writeChain.then(async () => {
    try {
      await chrome.storage.session.set({ [PERF_KEY]: buffer });
    } catch {
      // session storage unavailable — spans become best-effort in-memory
    }
  });
}

/**
 * Start a span. `end()` records it and returns the elapsed ms so callers can
 * accumulate (e.g. net work time per profile across a cycle).
 */
export function span(name: string): { end(meta?: Record<string, number | string>): number } {
  const start = performance.now();
  return {
    end(meta?: Record<string, number | string>): number {
      const ms = Math.round(performance.now() - start);
      void loadBuffer().then(() => {
        buffer.push({ name, ms, ts: Date.now(), ...(meta ? { meta } : {}) });
        if (buffer.length > RING_MAX) buffer = buffer.slice(-RING_MAX);
        persist();
      });
      return ms;
    },
  };
}

/** Dump the ring buffer (SW devtools: `(await import("./pipeline/perf")).getPerfSpans()`). */
export async function getPerfSpans(): Promise<PerfSpan[]> {
  await loadBuffer();
  return [...buffer];
}

/**
 * Coarse bucket label for telemetry values — "0_500", "500_2000", "5000_plus".
 * Edges must be ascending.
 */
export function coarseBucket(n: number, edges: number[]): string {
  let lo = 0;
  for (const edge of edges) {
    if (n < edge) return `${lo}_${edge}`;
    lo = edge;
  }
  return `${lo}_plus`;
}

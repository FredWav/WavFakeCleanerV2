/**
 * Anonymous error telemetry — ON by default since v3, opt-out via
 * Settings.telemetry.
 *
 * Posts a minimal JSON payload to the developer's Cloudflare Worker so bugs
 * affecting real users can be diagnosed without asking them to copy logs.
 *
 * Privacy:
 *   - Opt-out honored everywhere (this gate). A one-time notice is shown on
 *     update to v3; PRIVACY.md documents the exact fields.
 *   - No Threads username, no follower data, no log message body — community
 *     events carry only reason codes and counts, never target hashes.
 *   - The only stable identifier is a random UUID v4 generated locally.
 *   - The worker HMACs the anonId before storing it — a DB dump cannot be
 *     reversed to user identities without the server-side salt.
 */

import { TELEMETRY_URL } from "@shared/constants";
import { getSettings } from "./storage";

const ANON_ID_KEY = "wfc_anon_id";

async function getOrCreateAnonId(): Promise<string> {
  try {
    const stored = await chrome.storage.local.get(ANON_ID_KEY);
    const existing = stored?.[ANON_ID_KEY];
    if (typeof existing === "string" && existing.length >= 32) return existing;
    const id = crypto.randomUUID();
    await chrome.storage.local.set({ [ANON_ID_KEY]: id });
    return id;
  } catch {
    // chrome.storage may be unavailable during early SW startup — fall back to
    // a per-call random ID rather than failing.
    return crypto.randomUUID();
  }
}

export interface TelemetryEvent {
  category: string;        // e.g. "fetch", "clean", "scan", "community", "drift", "perf"
  errorCode: string;       // e.g. "scroll_container_not_found"
  reason?: string;         // e.g. "no_links"
  stage?: string;          // e.g. "fetching"
  value?: number;          // numeric payload (drift rank, queue depth, duration…)
}

// ── Client-side throttle ──
// Default-ON telemetry must not be able to flood the Worker (50/h per anon
// cap server-side). Best-effort: the map lives in SW memory and resets when
// MV3 terminates the worker — the server cap is the hard backstop.

const THROTTLE_WINDOW_MS = 3_600_000;
const THROTTLE_MAX_PER_WINDOW = 10;
const sendHistory = new Map<string, { windowStart: number; count: number }>();

function isThrottled(key: string): boolean {
  const now = Date.now();
  const entry = sendHistory.get(key);
  if (!entry || now - entry.windowStart >= THROTTLE_WINDOW_MS) {
    sendHistory.set(key, { windowStart: now, count: 1 });
    return false;
  }
  if (entry.count >= THROTTLE_MAX_PER_WINDOW) return true;
  entry.count++;
  return false;
}

export async function reportTelemetry(event: TelemetryEvent): Promise<void> {
  let settings;
  try {
    settings = await getSettings();
  } catch {
    return;
  }
  if (!settings?.telemetry) return; // opt-out honored

  if (isThrottled(`${event.category}:${event.errorCode}`)) return;

  let lang = "fr";
  try {
    const stored = await chrome.storage.local.get("wav_lang");
    if (typeof stored?.wav_lang === "string") lang = stored.wav_lang;
  } catch { /* ignore */ }

  const version = chrome.runtime?.getManifest?.().version ?? "unknown";
  const anonId = await getOrCreateAnonId();

  const payload = {
    anonId,
    v: version,
    lang,
    ts: Date.now(),
    category: event.category,
    errorCode: event.errorCode,
    reason: event.reason,
    stage: event.stage,
    value: typeof event.value === "number" && Number.isFinite(event.value)
      ? Math.round(event.value)
      : undefined,
  };

  // Fire-and-forget. We deliberately swallow errors: telemetry must never
  // break the user's workflow, and the user has no way to act on a failure.
  try {
    await fetch(TELEMETRY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    // ignore
  }
}

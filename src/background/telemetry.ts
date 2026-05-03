/**
 * Anonymous error telemetry — opt-in (Settings.telemetry).
 *
 * Posts a minimal JSON payload to the developer's Cloudflare Worker so bugs
 * affecting real users can be diagnosed without asking them to copy logs.
 *
 * Privacy:
 *   - Strictly opt-in. Off by default.
 *   - No Threads username, no follower data, no log message body.
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
  category: string;        // e.g. "fetch", "clean", "scan"
  errorCode: string;       // e.g. "scroll_container_not_found"
  reason?: string;         // e.g. "no_links"
  stage?: string;          // e.g. "fetching"
}

export async function reportTelemetry(event: TelemetryEvent): Promise<void> {
  let settings;
  try {
    settings = await getSettings();
  } catch {
    return;
  }
  if (!settings?.telemetry) return; // opt-in only

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

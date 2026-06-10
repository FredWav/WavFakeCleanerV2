/**
 * useStats — live stats via STATS_UPDATED broadcasts + adaptive polling.
 *
 * The broadcast channel is the primary live feed (the pipeline pushes stats
 * on every page persist / state change). Polling is the reconciliation
 * fallback — and every GET_STATS materializes the whole followers store in
 * the service worker (computeStats does a full getAll), so the idle cadence
 * matters: 2-3 s while a run is active, 15 s when idle.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "../lib/messaging";
import type { Stats } from "@shared/types";

const ACTIVE_INTERVAL_MS = 3000;
const IDLE_INTERVAL_MS = 15000;

export function useStats(activeIntervalMs = ACTIVE_INTERVAL_MS) {
  const [stats, setStats] = useState<Stats | null>(null);
  const statsRef = useRef<Stats | null>(null);
  statsRef.current = stats;

  const refresh = useCallback(async () => {
    try {
      const data = await api.getStats();
      setStats(data);
    } catch {
      // silent
    }
  }, []);

  // Self-rescheduling poll: the next delay is decided AFTER each tick from
  // the freshest known state, so a finished run drops to the idle cadence
  // without waiting for a re-render.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      await refresh();
      if (cancelled) return;
      const delay = statsRef.current?.isRunning ? activeIntervalMs : IDLE_INTERVAL_MS;
      timer = setTimeout(tick, delay);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [refresh, activeIntervalMs]);

  // Primary live channel: broadcast stats updates from the service worker.
  useEffect(() => {
    const listener = (message: { type?: string; payload?: Stats }) => {
      if (message.type === "STATS_UPDATED" && message.payload) {
        setStats(message.payload);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  return { stats, refresh };
}

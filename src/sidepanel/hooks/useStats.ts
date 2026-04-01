/**
 * useStats — replaces REST polling with chrome.runtime messaging + storage events.
 */

import { useState, useEffect, useCallback } from "react";
import { api } from "../lib/messaging";
import type { Stats } from "@shared/types";

export function useStats(intervalMs = 3000) {
  const [stats, setStats] = useState<Stats | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api.getStats();
      setStats(data);
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, intervalMs);
    return () => clearInterval(id);
  }, [refresh, intervalMs]);

  // Also listen for broadcast stats updates
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

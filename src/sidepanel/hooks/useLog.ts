/**
 * useLog — replaces WebSocket with chrome.runtime.onMessage listener.
 */

import { useState, useEffect, useCallback } from "react";
import type { LogEntry } from "@shared/types";

export function useLog(maxLogs = 200) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState(true); // always "connected" in extension

  useEffect(() => {
    const listener = (message: { type?: string; payload?: LogEntry }) => {
      if (message.type === "LOG_EVENT" && message.payload) {
        setLogs((prev) => {
          const next = [...prev, message.payload!];
          return next.length > maxLogs ? next.slice(-maxLogs) : next;
        });
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [maxLogs]);

  const clearLogs = useCallback(() => setLogs([]), []);

  return { logs, connected, clearLogs };
}

/**
 * Pipeline state — log/broadcast/state-update helpers.
 *
 * Centralized so every pipeline module logs and broadcasts the same way.
 * The pipeline.ts orchestrator must register the running-status getter
 * (isRunning) and the rate stats provider so computeStats() has fresh data.
 */

import type { LogEntry, PipelineState, Stats } from "@shared/types";
import type { BroadcastMessage } from "@shared/messages";
import { computeStats, getPipelineState, savePipelineState } from "../storage";

// ── Runtime providers (registered by pipeline.ts at module load) ──

let isRunningProvider: () => boolean = () => false;
let rateStatsProvider: () => Stats["rate"] = () => ({
  actionsThisHour: 0,
  limitHour: 0,
  consecutiveErrors: 0,
});

/**
 * Inject the providers used by broadcastStats(). Called once from pipeline.ts.
 */
export function configureStateProviders(providers: {
  isRunning: () => boolean;
  rateStats: () => Stats["rate"];
}): void {
  isRunningProvider = providers.isRunning;
  rateStatsProvider = providers.rateStats;
}

// ── Broadcast / log ──

export function broadcast(msg: BroadcastMessage): void {
  chrome.runtime.sendMessage(msg).catch(() => {
    // sidepanel may not be open
  });
}

export function log(level: LogEntry["level"], category: string, message: string): void {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    category,
    message,
  };
  broadcast({ type: "LOG_EVENT", payload: entry });
}

export async function broadcastStats(): Promise<void> {
  const stats = await computeStats(isRunningProvider(), rateStatsProvider());
  broadcast({ type: "STATS_UPDATED", payload: stats });
}

/**
 * Merge a partial state update over the existing persisted state.
 *
 * Critical: do NOT replace state wholesale. Calling updateState({ stage: "idle" })
 * in a finally{} block was previously wiping the lastError set by the error
 * branch immediately before it.
 */
export async function updateState(state: Partial<PipelineState>): Promise<void> {
  const current = (await getPipelineState()) || {
    stage: "idle" as const,
    sessionId: null,
    progress: 0,
    total: 0,
    lastError: null,
  };
  const full: PipelineState = { ...current, ...state };
  await savePipelineState(full);
  broadcast({ type: "PIPELINE_STATE", payload: full });
}

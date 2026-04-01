import { useState } from "react";
import { api } from "../lib/messaging";
import { t } from "../lib/i18n";
import type { Stats } from "@shared/types";

export default function ControlPanel({
  stats,
  lang,
  onRefresh,
}: {
  stats: Stats | null;
  lang: string;
  onRefresh: () => void;
}) {
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isRunning = stats?.isRunning;

  async function run(action: string) {
    setLoading(action);
    setError(null);
    try {
      const fn = api[action as keyof typeof api] as () => Promise<unknown>;
      await fn();
      setTimeout(onRefresh, 500);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(null);
    }
  }

  const btn = (label: string, action: string, color: string) => (
    <button
      onClick={() => run(action)}
      disabled={!!loading || (!!isRunning && action !== "stop")}
      className={`px-3 py-1.5 rounded-lg font-medium text-xs transition-all
        ${
          isRunning && action !== "stop"
            ? "bg-gray-800 text-gray-600 cursor-not-allowed"
            : `${color} hover:brightness-110 active:scale-95`
        }
        ${loading === action ? "animate-pulse" : ""}`}
    >
      {t(label, lang)}
    </button>
  );

  return (
    <div className="space-y-2">
      <div className="flex gap-1.5 flex-wrap">
        {btn("fetch", "fetch", "bg-blue-600 text-white")}
        {btn("scan", "scan", "bg-cyan-600 text-white")}
        {btn("clean", "clean", "bg-orange-600 text-white")}
        {btn("reset_scanned", "resetScanned", "bg-yellow-600 text-white")}
        {btn("autopilot", "autopilot", "bg-purple-600 text-white")}
      </div>
      <div className="flex gap-1.5">
        <button
          onClick={() => run("stop")}
          disabled={!!loading || !isRunning}
          className={`px-3 py-1.5 rounded-lg font-medium text-xs transition-all w-full
            ${isRunning
              ? "bg-red-600 text-white hover:bg-red-500 active:scale-95 animate-pulse"
              : "bg-gray-800 text-gray-600 cursor-not-allowed"
            }`}
        >
          {isRunning ? t("stop", lang) : t("stopped", lang)}
        </button>
      </div>
      {error && (
        <div className="text-red-400 text-xs bg-red-500/10 rounded-lg px-2 py-1">{error}</div>
      )}
    </div>
  );
}

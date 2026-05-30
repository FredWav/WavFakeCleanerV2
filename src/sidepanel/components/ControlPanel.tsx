import { useState, useEffect } from "react";
import { api } from "../lib/messaging";
import { t } from "../lib/i18n";
import type { Stats, LicenseInfo } from "@shared/types";

function formatMMSS(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/**
 * Live countdown shown while the pipeline is in a long anti-block pause (hard
 * 429, error-page cooldown, mandatory session break, between-cycle pause).
 * Without it the progress bar just looks frozen for minutes/hours.
 */
function PauseBanner({ until, reason, lang }: { until: number; reason: string | null; lang: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const remaining = until - now;
  const reasonLabel = reason ? t(`pause_reason_${reason}`, lang) : "";
  return (
    <div className="text-amber-300 text-xs bg-amber-500/10 border border-amber-500/20 rounded-lg px-2 py-1.5 leading-snug">
      <div className="font-semibold">
        {t("pause_title", lang)}
        {reasonLabel ? <span className="font-normal opacity-80"> · {reasonLabel}</span> : null}
      </div>
      <div className="opacity-90 tabular-nums">
        {remaining > 0
          ? t("pause_resume_in", lang).replace("{0}", formatMMSS(remaining))
          : t("running", lang)}
      </div>
    </div>
  );
}

export default function ControlPanel({
  stats,
  lang,
  licence,
  onRefresh,
}: {
  stats: Stats | null;
  lang: string;
  licence: LicenseInfo;
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
      console.error("[WFC] action failed:", e);
      setError(t("action_failed", lang));
    } finally {
      setLoading(null);
    }
  }

  // For licensed users, "Nettoyer" launches continuous mode
  function handleClean() {
    if (licence.active) {
      run("continuous");
    } else {
      run("clean");
    }
  }

  const progress = stats && stats.totalFollowers > 0
    ? Math.min(100, Math.round((stats.scanned / stats.totalFollowers) * 100))
    : 0;

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <button
          onClick={() => run("fetch")}
          disabled={!!loading || !!isRunning}
          className={`flex-1 px-3 py-2 rounded-lg font-medium text-sm transition-all
            ${isRunning
              ? "bg-gray-800 text-gray-600 cursor-not-allowed"
              : "bg-blue-600 text-white hover:bg-blue-500 active:scale-95"
            }
            ${loading === "fetch" ? "animate-pulse" : ""}`}
        >
          {t("fetch", lang)}
        </button>
        <button
          onClick={handleClean}
          disabled={!!loading || !!isRunning}
          className={`flex-1 px-3 py-2 rounded-lg font-medium text-sm transition-all
            ${isRunning
              ? "bg-gray-800 text-gray-600 cursor-not-allowed"
              : "bg-purple-600 text-white hover:bg-purple-500 active:scale-95"
            }
            ${loading === "clean" || loading === "continuous" ? "animate-pulse" : ""}`}
        >
          {t("clean_btn", lang)}
          {licence.active && (
            <span className="ml-1 text-[10px] opacity-70">{t("continuous_label", lang)}</span>
          )}
        </button>
      </div>

      <button
        onClick={() => run("stop")}
        disabled={!!loading || !isRunning}
        className={`w-full px-3 py-2 rounded-lg font-medium text-sm transition-all
          ${isRunning
            ? "bg-red-600 text-white hover:bg-red-500 active:scale-95 animate-pulse"
            : "bg-gray-800 text-gray-600 cursor-not-allowed"
          }`}
      >
        {isRunning ? t("stop", lang) : t("stopped", lang)}
      </button>

      {/* Anti-block pause countdown (explains why the bar is frozen) */}
      {isRunning && stats?.pausedUntil ? (
        <PauseBanner until={stats.pausedUntil} reason={stats.pauseReason ?? null} lang={lang} />
      ) : null}

      {/* Progress bar */}
      {isRunning && stats && stats.totalFollowers > 0 && (
        <div className="space-y-1">
          <div className="flex justify-between text-[10px] text-gray-500">
            <span>{t("progress_label", lang)}</span>
            <span>{progress}%</span>
          </div>
          <div className="w-full h-1.5 bg-gray-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-purple-600 rounded-full transition-all duration-700 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {error && (
        <div className="text-red-400 text-xs bg-red-500/10 rounded-lg px-2 py-1">{error}</div>
      )}

      {/* Pipeline-level error from the last fetch/clean run. Distinct from the
          local action error above (which only covers api.* failures). */}
      {!error && !isRunning && stats?.lastError && (
        <div className="text-red-400 text-xs bg-red-500/10 rounded-lg px-2 py-1.5 leading-snug">
          {stats.lastError}
        </div>
      )}

      {/* Persistent honesty note: fetching is scroll-based and caps ~5000/pass. */}
      <p className="text-[10px] text-gray-500 leading-snug">{t("fetch_limit_note", lang)}</p>
    </div>
  );
}

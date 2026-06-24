import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "../lib/messaging";
import { t } from "../lib/i18n";
import type { CommunityStatus, LicenseInfo } from "@shared/types";
import { IconGlobe, IconRefresh } from "./Icons";
import Skeleton from "./ui/Skeleton";

/**
 * Community status card — the user-facing half of the v3 observability work.
 * Shows what used to be invisible: contributions delivered, waiting in the
 * retry queue, or lost (and why), plus licence/token health with a one-click
 * path to fix it. Hidden for unlicensed users (they can't vote).
 */

function timeAgo(ts: number, lang: string): string {
  const minutes = Math.round((Date.now() - ts) / 60_000);
  if (minutes < 1) return t("just_now", lang);
  try {
    const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "always" });
    if (minutes < 60) return rtf.format(-minutes, "minute");
    const hours = Math.round(minutes / 60);
    if (hours < 24) return rtf.format(-hours, "hour");
    return rtf.format(-Math.round(hours / 24), "day");
  } catch {
    return new Date(ts).toLocaleTimeString();
  }
}

function reasonLabel(reason: string, lang: string): string {
  const key = `reason_${reason}`;
  const label = t(key, lang);
  // t() echoes the key when there is no translation — fall back to the code.
  return label === key ? reason : label;
}

export default function CommunityCard({
  lang,
  licence,
  onShowLicence,
  showToast,
}: {
  lang: string;
  licence?: LicenseInfo;
  onShowLicence?: () => void;
  showToast?: (msg: string) => void;
}) {
  const [status, setStatus] = useState<CommunityStatus | null>(null);
  const [replaying, setReplaying] = useState(false);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(() => {
    api.getCommunityStatus().then(setStatus).catch(() => {});
  }, []);

  // Refetch on mount and whenever the service worker pings a status change.
  // Pings can burst (one per vote during a clean cycle) — trailing debounce.
  useEffect(() => {
    if (!licence?.active) return;
    refresh();
    const listener = (message: { type?: string }) => {
      if (message.type !== "COMMUNITY_STATUS_UPDATED") return;
      if (refreshTimer.current) return;
      refreshTimer.current = setTimeout(() => {
        refreshTimer.current = null;
        refresh();
      }, 500);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => {
      chrome.runtime.onMessage.removeListener(listener);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
    };
  }, [licence?.active, refresh]);

  if (!licence?.active) return null;

  if (!status) {
    return (
      <div className="bg-gray-900 rounded-xl border border-gray-800 px-3 py-2 space-y-1.5">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-4 w-48" />
      </div>
    );
  }

  async function replayNow() {
    setReplaying(true);
    try {
      const result = await api.replayCommunityQueue();
      showToast?.(t("community_replay_done", lang).replace("{0}", String(result.replayed)));
      refresh();
    } catch {
      // the next ping/alarm will reconcile
    } finally {
      setReplaying(false);
    }
  }

  const tokenPill =
    status.tokenStatus === "invalid" ? (
      <button
        onClick={onShowLicence}
        className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-red-500/20 text-red-400
          border border-red-900/40 hover:bg-red-500/30 transition-colors"
      >
        {t("community_token_invalid", lang)}
      </button>
    ) : status.tokenStatus === "ok" ? (
      <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-green-500/15 text-green-400">
        {t("community_token_ok", lang)}
      </span>
    ) : null;

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 px-3 py-2 space-y-1.5">
      <div className="flex items-center justify-between">
        <div className="text-[11px] text-blue-400/70 uppercase font-semibold tracking-wide flex items-center gap-1">
          <IconGlobe /> {t("community_card_title", lang)}
        </div>
        {tokenPill}
      </div>

      <div className="flex items-center gap-3 text-[11px]">
        <span className="text-gray-400">
          {t("community_sent_label", lang)}{" "}
          <span className="text-green-400 font-semibold">{status.sent}</span>
        </span>
        <span className="text-gray-400">
          {t("community_pending_label", lang)}{" "}
          <span className={`font-semibold ${status.queueLength > 0 ? "text-yellow-400" : "text-gray-500"}`}>
            {status.queueLength}
          </span>
        </span>
        <span className="text-gray-400">
          {t("community_dropped_label", lang)}{" "}
          <span className={`font-semibold ${status.dropped > 0 ? "text-red-400" : "text-gray-500"}`}>
            {status.dropped}
          </span>
          {status.dropped > 0 && status.lastDropReason && (
            <span className="text-gray-600"> ({reasonLabel(status.lastDropReason, lang)})</span>
          )}
        </span>
        {status.queueLength > 0 && (
          <button
            onClick={replayNow}
            disabled={replaying}
            className="ml-auto flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11px]
              bg-gray-800 text-gray-300 hover:text-white transition-colors disabled:opacity-50"
          >
            <IconRefresh /> {t("community_replay_now", lang)}
          </button>
        )}
      </div>

      {status.lastReplay && (status.lastReplay.replayed > 0 || status.lastReplay.dropped > 0 || status.queueLength > 0) && (
        <div className="text-[11px] text-gray-600">
          {t("community_last_replay", lang)
            .replace("{0}", timeAgo(status.lastReplay.ts, lang))
            .replace("{1}", String(status.lastReplay.replayed))
            .replace("{2}", String(status.lastReplay.dropped))}
        </div>
      )}
    </div>
  );
}

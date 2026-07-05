import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "../lib/messaging";
import { t } from "../lib/i18n";
import type { CommunityStatus, LicenseInfo } from "@shared/types";
import { IconGlobe } from "./Icons";
import Skeleton from "./ui/Skeleton";

/**
 * Carte communauté — Lot 3 : on ne montre plus la plomberie du Worker
 * (file d'attente, perdus, raison technique, bouton « Réessayer », dernier
 * renvoi) qui était un tableau de bord d'ingénieur exposé en façade. On garde
 * UNE ligne de valorisation (« X faux signalés à la communauté ») et, seul
 * signal actionnable conservé, la pastille « licence à réactiver » si le jeton
 * est invalide. La file de réessai continue de tourner silencieusement en fond
 * (alarme du service worker) — seule son exposition disparaît. Masquée pour les
 * utilisateurs sans licence (ils ne votent pas).
 */
export default function CommunityCard({
  lang,
  licence,
  onShowLicence,
}: {
  lang: string;
  licence?: LicenseInfo;
  onShowLicence?: () => void;
  showToast?: (msg: string) => void;
}) {
  const [status, setStatus] = useState<CommunityStatus | null>(null);
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
      <div className="bg-surface rounded-xl border border-line px-3 py-2 space-y-1.5">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-4 w-48" />
      </div>
    );
  }

  return (
    <div className="bg-surface rounded-xl border border-line px-3 py-2 space-y-1.5">
      <div className="flex items-center justify-between">
        <div className="text-[11px] text-ink-faint uppercase font-semibold tracking-wide flex items-center gap-1">
          <IconGlobe /> {t("community_card_title", lang)}
        </div>
        {status.tokenStatus === "invalid" && (
          <button
            onClick={onShowLicence}
            className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-suspect-bg text-suspect
              border border-suspect/20 hover:bg-suspect/10 transition-colors"
          >
            {t("community_token_invalid", lang)}
          </button>
        )}
      </div>

      {/* Valorisation de la contribution — la fierté, pas la tuyauterie. */}
      <p className="text-xs text-ink-soft">
        {t("community_contribution", lang).replace("{0}", status.sent.toLocaleString())}
      </p>
    </div>
  );
}

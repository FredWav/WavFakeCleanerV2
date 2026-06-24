import { useState, useEffect, useCallback, useRef } from "react";
import { useStats } from "./hooks/useStats";
import { useLog } from "./hooks/useLog";
import { t, getStoredLang, setStoredLang } from "./lib/i18n";
import { api } from "./lib/messaging";
import StatCards from "./components/StatCards";
import ControlPanel from "./components/ControlPanel";
import CommunityCard from "./components/CommunityCard";
import LogConsole from "./components/LogConsole";
import FollowerTable from "./components/FollowerTable";
import SettingsPanel from "./components/SettingsPanel";
import LicencePanel from "./components/LicencePanel";
import Toast from "./components/Toast";
import Onboarding from "./components/Onboarding";
import { IconX } from "./components/Icons";
import { COMMUNITY_STATS_URL } from "@shared/constants";
import type { LicenseInfo } from "@shared/types";

// Logo de marque (icône Chrome existante) — affiché dans l'en-tête (D2 :
// l'identité dormait dans le dossier /design et n'apparaissait jamais dans l'UI).
const LOGO_URL = chrome.runtime?.getURL?.("icons/icon128.png") ?? "icons/icon128.png";

export default function App() {
  const [lang, setLang] = useState(getStoredLang);
  const [showSettings, setShowSettings] = useState(false);
  const [showLicence, setShowLicence] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [licence, setLicence] = useState<LicenseInfo>({ active: false, key: null, activatedAt: null, communityToken: null });
  // U-L2 : file de toasts empilables (avant : un seul toast, le suivant écrasait
  // le précédent). Cap à 4 affichés ; chaque toast s'auto-efface.
  const toastId = useRef(0);
  const [toasts, setToasts] = useState<{ id: number; msg: string }[]>([]);
  const pushToast = useCallback((msg: string) => {
    const id = ++toastId.current;
    setToasts((q) => [...q, { id, msg }].slice(-4));
  }, []);
  const dismissToast = useCallback((id: number) => {
    setToasts((q) => q.filter((to) => to.id !== id));
  }, []);
  const [communityTotal, setCommunityTotal] = useState<number | null>(null);
  const [prescan, setPrescan] = useState<{ likelyFakes: number; total: number } | null>(null);
  const [showTelemetryNotice, setShowTelemetryNotice] = useState(false);
  const { stats, refresh } = useStats(3000);
  const { logs, connected, clearLogs } = useLog(300);

  // One-time notice after the v3 update: telemetry is now on by default.
  // The flag is set by the onInstalled migration and cleared on dismiss.
  useEffect(() => {
    chrome.storage.local.get("wfc_telemetry_notice_pending").then((r) => {
      if (r?.wfc_telemetry_notice_pending) setShowTelemetryNotice(true);
    }).catch(() => {});
  }, []);

  function dismissTelemetryNotice() {
    setShowTelemetryNotice(false);
    chrome.storage.local.remove("wfc_telemetry_notice_pending").catch(() => {});
  }

  // Total communautaire de faux, récupéré une fois et partagé avec la bannière de
  // stats et la fenêtre Licence (preuve sociale). Échoue en silence — purement décoratif.
  useEffect(() => {
    fetch(COMMUNITY_STATS_URL)
      .then((r) => r.json())
      .then((d: { totalFakesDetected?: number }) => {
        if (typeof d.totalFakesDetected === "number" && d.totalFakesDetected > 0) {
          setCommunityTotal(d.totalFakesDetected);
        }
      })
      .catch(() => {});
  }, []);

  // « Chiffre choc » gratuit : une fois les abonnés récupérés (et à l'arrêt), on
  // compte les faux évidents à partir des seules métadonnées — sans scan, sans
  // suppression, sans coût quotidien — pour que l'utilisateur voie l'ampleur du
  // problème en quelques secondes, et non après un long nettoyage.
  useEffect(() => {
    if (!stats || stats.isRunning || (stats.totalFollowers ?? 0) <= 0) return;
    let cancelled = false;
    api.getPrescanEstimate()
      .then((r) => { if (!cancelled) setPrescan(r); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [stats?.isRunning, stats?.totalFollowers]);

  // Réagit en direct à une licence qui devient active dans le stockage — ex. le
  // content script de la page /success l'active après paiement pendant que ce
  // panneau est ouvert. Sans ça, le panneau reste verrouillé et l'acheteur croit
  // que ça a échoué. Surveille les deux zones de stockage (local + sauvegarde sync).
  useEffect(() => {
    function onChanged(
      changes: Record<string, chrome.storage.StorageChange>,
      area: string
    ) {
      if ((area === "local" || area === "sync") && changes.license) {
        api.getLicense().then((lic) => {
          setLicence(lic);
          if (!licence.active && lic.active) pushToast(t("licence_success", lang));
        }).catch(() => {});
      }
    }
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [licence.active, lang]);

  // Initial load: settings (for onboarding gate) and licence state.
  // Split into separate effects so each has a single, obvious responsibility
  // and can re-run independently if its dependency changes.
  useEffect(() => {
    let cancelled = false;
    api.getSettings().then((s) => {
      if (cancelled) return;
      if (!s.threadsUsername && !localStorage.getItem("wav_onboarding_done")) {
        setShowOnboarding(true);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.getLicense().then((lic) => {
      if (cancelled) return;
      setLicence(lic);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Auto-refresh communityToken for licences activated before the community
  // deployment. Runs only when the licence has a key but no token, and
  // re-runs when the key changes (e.g. user activates a fresh licence).
  useEffect(() => {
    if (!licence.active || !licence.key || licence.communityToken) return;
    let cancelled = false;
    api.activateLicense(licence.key).then((result) => {
      if (cancelled) return;
      if (result?.ok) {
        api.getLicense().then((l) => { if (!cancelled) setLicence(l); }).catch(() => {});
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [licence.active, licence.key, licence.communityToken]);

  // Surface a one-time toast when a selector drift is detected on Threads.
  // The content script reports drift as LOG_FROM_CONTENT with category="drift";
  // service-worker rebroadcasts as LOG_EVENT. Capping to once per session
  // prevents toast spam if multiple lookups fall back simultaneously.
  useEffect(() => {
    let shown = false;
    const listener = (message: { type?: string; payload?: { category?: string } }) => {
      if (shown) return;
      if (message.type !== "LOG_EVENT") return;
      if (message.payload?.category !== "drift") return;
      shown = true;
      pushToast(t("drift_detected", lang));
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [lang]);

  function toggleLang() {
    const cycle: Record<string, string> = { fr: "en", en: "es", es: "fr" };
    const next = cycle[lang] || "fr";
    setLang(next);
    setStoredLang(next);
  }

  function onLicenceUpdate(l: LicenseInfo) {
    setLicence(l);
    setShowLicence(false);
  }

  return (
    <div className="w-full px-3 py-4 space-y-4">
      {/* Header */}
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <img src={LOGO_URL} alt="Wav Fake Cleaner" className="w-7 h-7 rounded-md shrink-0" />
          <div>
            <h1 className="text-lg font-bold text-white leading-none">Wav Fake Cleaner</h1>
            <p className="text-[11px] text-gray-500">
              by{" "}
              <a
                href="https://fredwav.com/contact"
                target="_blank"
                rel="noopener noreferrer"
                className="text-purple-400 hover:text-purple-300 transition-colors"
              >
                Fred Wav
              </a>
            </p>
          </div>
        </div>
        <div className="flex gap-1.5 items-center">
          <button
            onClick={() => setShowLicence(true)}
            className={`px-2 py-1 rounded-lg text-[11px] font-bold transition-colors
              ${licence.active
                ? "bg-green-600/20 text-green-400 border border-green-600/30"
                : "bg-accent text-accent-ink hover:bg-accent-hover"
              }`}
          >
            {licence.active ? t("licence_active", lang) : t("licence", lang)}
          </button>
          <button
            onClick={() => setShowSettings(true)}
            className="px-2 py-1 rounded-lg bg-gray-800 text-[11px] text-gray-400
              hover:text-white transition-colors"
          >
            {t("settings", lang)}
          </button>
          <button
            onClick={toggleLang}
            className="px-2 py-1 rounded-lg bg-gray-800 text-[11px] text-gray-400
              hover:text-white transition-colors"
          >
            {t("lang_toggle", lang)}
          </button>
        </div>
      </header>

      {/* One-time v3 telemetry notice */}
      {showTelemetryNotice && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-xl border border-purple-800/40 bg-purple-950/30 text-[11px] text-purple-200">
          <span className="flex-1 leading-snug">{t("telemetry_notice", lang)}</span>
          <button
            onClick={() => { dismissTelemetryNotice(); setShowSettings(true); }}
            className="shrink-0 px-2 py-0.5 rounded bg-purple-600/40 text-purple-100 hover:bg-purple-600/60 transition-colors"
          >
            {t("telemetry_notice_cta", lang)}
          </button>
          <button
            onClick={dismissTelemetryNotice}
            className="shrink-0 text-purple-400 hover:text-white transition-colors p-0.5"
            aria-label={t("confirm_cancel", lang)}
          >
            <IconX />
          </button>
        </div>
      )}

      {/* Stats */}
      <StatCards stats={stats} lang={lang} communityTotal={communityTotal} />

      {/* Community status (licensed users) */}
      <CommunityCard
        lang={lang}
        licence={licence}
        onShowLicence={() => setShowLicence(true)}
        showToast={pushToast}
      />

      {/* Accroche post-fetch : combien de faux déjà repérés via les métadonnées */}
      {prescan && prescan.likelyFakes > 0 && !stats?.isRunning && (
        <div className="text-xs text-red-200 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 leading-snug">
          {t("prescan_banner", lang)
            .replace("{0}", prescan.likelyFakes.toLocaleString())
            .replace("{1}", prescan.total.toLocaleString())}
        </div>
      )}

      {/* Controls */}
      <ControlPanel stats={stats} lang={lang} licence={licence} onRefresh={refresh} />

      {/* Logs */}
      <LogConsole logs={logs} connected={connected} onClear={clearLogs} lang={lang} />

      {/* Follower table */}
      <FollowerTable
        lang={lang}
        licence={licence}
        onShowLicence={() => setShowLicence(true)}
        showToast={pushToast}
        refreshTrigger={(stats?.totalFollowers ?? 0) + (stats?.scanned ?? 0) + (stats?.removed ?? 0)}
      />

      {/* Settings modal */}
      {showSettings && (
        <SettingsPanel
          lang={lang}
          onClose={() => setShowSettings(false)}
          showToast={pushToast}
        />
      )}

      {/* Licence modal */}
      {showLicence && (
        <LicencePanel
          lang={lang}
          licence={licence}
          onUpdate={onLicenceUpdate}
          onClose={() => setShowLicence(false)}
          showToast={pushToast}
          communityTotal={communityTotal}
        />
      )}

      {/* Onboarding */}
      {showOnboarding && (
        <Onboarding
          lang={lang}
          onDismiss={() => setShowOnboarding(false)}
          onOpenSettings={() => { setShowOnboarding(false); setShowSettings(true); }}
        />
      )}

      {/* Toasts empilés (U-L2) */}
      <div className="fixed bottom-3 left-3 right-3 z-50 flex flex-col items-center gap-1.5 pointer-events-none">
        {toasts.map((to) => (
          <Toast key={to.id} message={to.msg} onDismiss={() => dismissToast(to.id)} />
        ))}
      </div>
    </div>
  );
}

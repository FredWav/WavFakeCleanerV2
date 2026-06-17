import { useState, useEffect } from "react";
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
import { COMMUNITY_STATS_URL } from "@shared/constants";
import type { LicenseInfo } from "@shared/types";

export default function App() {
  const [lang, setLang] = useState(getStoredLang);
  const [showSettings, setShowSettings] = useState(false);
  const [showLicence, setShowLicence] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [licence, setLicence] = useState<LicenseInfo>({ active: false, key: null, activatedAt: null, communityToken: null });
  const [toast, setToast] = useState<string | null>(null);
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

  // Community-wide fake count, fetched once and shared with the stats banner and
  // the licence modal (social proof). Fails silently — it's purely decorative.
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

  // Free "chiffre choc": once followers are fetched (and we're idle), count the
  // obvious fakes from metadata alone — no scan, no removal, no daily cost — so
  // the user sees the scale of the problem in seconds, not after a long clean.
  useEffect(() => {
    if (!stats || stats.isRunning || (stats.totalFollowers ?? 0) <= 0) return;
    let cancelled = false;
    api.getPrescanEstimate()
      .then((r) => { if (!cancelled) setPrescan(r); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [stats?.isRunning, stats?.totalFollowers]);

  // Live-react to a licence becoming active in storage — e.g. the /success page
  // content script activates after payment while this panel is open. Without
  // this, the panel keeps showing the locked state and the buyer thinks it
  // failed. Mirrors both storage areas (local + sync backup).
  useEffect(() => {
    function onChanged(
      changes: Record<string, chrome.storage.StorageChange>,
      area: string
    ) {
      if ((area === "local" || area === "sync") && changes.license) {
        api.getLicense().then((lic) => {
          setLicence(lic);
          if (!licence.active && lic.active) setToast(t("licence_success", lang));
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
      setToast(t("drift_detected", lang));
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
        <div>
          <h1 className="text-lg font-bold text-white">Wav Fake Cleaner</h1>
          <p className="text-[10px] text-gray-500">
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
        <div className="flex gap-1.5 items-center">
          <button
            onClick={() => setShowLicence(true)}
            className={`px-2 py-1 rounded-lg text-[10px] font-medium transition-colors
              ${licence.active
                ? "bg-green-600/20 text-green-400 border border-green-600/30"
                : "bg-purple-600 text-white hover:bg-purple-500"
              }`}
          >
            {licence.active ? t("licence_active", lang) : t("licence", lang)}
          </button>
          <button
            onClick={() => setShowSettings(true)}
            className="px-2 py-1 rounded-lg bg-gray-800 text-[10px] text-gray-400
              hover:text-white transition-colors"
          >
            {t("settings", lang)}
          </button>
          <button
            onClick={toggleLang}
            className="px-2 py-1 rounded-lg bg-gray-800 text-[10px] text-gray-400
              hover:text-white transition-colors"
          >
            {t("lang_toggle", lang)}
          </button>
        </div>
      </header>

      {/* One-time v3 telemetry notice */}
      {showTelemetryNotice && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-xl border border-purple-800/40 bg-purple-950/30 text-[10px] text-purple-200">
          <span className="flex-1 leading-snug">{t("telemetry_notice", lang)}</span>
          <button
            onClick={() => { dismissTelemetryNotice(); setShowSettings(true); }}
            className="shrink-0 px-2 py-0.5 rounded bg-purple-600/40 text-purple-100 hover:bg-purple-600/60 transition-colors"
          >
            {t("telemetry_notice_cta", lang)}
          </button>
          <button
            onClick={dismissTelemetryNotice}
            className="shrink-0 text-purple-400 hover:text-white transition-colors text-sm leading-none"
            aria-label="Dismiss"
          >
            ×
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
        showToast={setToast}
      />

      {/* Post-fetch teaser: how many fakes we already spotted from metadata */}
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
        showToast={setToast}
        refreshTrigger={(stats?.totalFollowers ?? 0) + (stats?.scanned ?? 0) + (stats?.removed ?? 0)}
      />

      {/* Settings modal */}
      {showSettings && (
        <SettingsPanel
          lang={lang}
          onClose={() => setShowSettings(false)}
          showToast={setToast}
        />
      )}

      {/* Licence modal */}
      {showLicence && (
        <LicencePanel
          lang={lang}
          licence={licence}
          onUpdate={onLicenceUpdate}
          onClose={() => setShowLicence(false)}
          showToast={setToast}
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

      {/* Toast */}
      <Toast message={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}

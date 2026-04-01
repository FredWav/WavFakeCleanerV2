import { useState, useEffect } from "react";
import { useStats } from "./hooks/useStats";
import { useLog } from "./hooks/useLog";
import { t, getStoredLang, setStoredLang } from "./lib/i18n";
import { api } from "./lib/messaging";
import StatCards from "./components/StatCards";
import ControlPanel from "./components/ControlPanel";
import LogConsole from "./components/LogConsole";
import FollowerTable from "./components/FollowerTable";
import SettingsPanel from "./components/SettingsPanel";
import LicencePanel from "./components/LicencePanel";
import type { LicenseInfo } from "@shared/types";

export default function App() {
  const [lang, setLang] = useState(getStoredLang);
  const [showSettings, setShowSettings] = useState(false);
  const [showLicence, setShowLicence] = useState(false);
  const [licence, setLicence] = useState<LicenseInfo>({ active: false, key: null, activatedAt: null });
  const { stats, refresh } = useStats(3000);
  const { logs, connected, clearLogs } = useLog(300);

  useEffect(() => {
    api.getLicense().then(setLicence).catch(() => {});
  }, []);

  function toggleLang() {
    const next = lang === "fr" ? "en" : "fr";
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
              href="https://www.threads.net/@fredwavoff"
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

      {/* Stats */}
      <StatCards stats={stats} lang={lang} />

      {/* Controls */}
      <ControlPanel stats={stats} lang={lang} onRefresh={refresh} />

      {/* Logs */}
      <LogConsole logs={logs} connected={connected} onClear={clearLogs} lang={lang} />

      {/* Follower table */}
      <FollowerTable lang={lang} refreshTrigger={(stats?.totalFollowers ?? 0) + (stats?.scanned ?? 0) + (stats?.removed ?? 0)} />

      {/* Settings modal */}
      {showSettings && (
        <SettingsPanel
          lang={lang}
          hasLicence={licence.active}
          onClose={() => setShowSettings(false)}
        />
      )}

      {/* Licence modal */}
      {showLicence && (
        <LicencePanel
          lang={lang}
          licence={licence}
          onUpdate={onLicenceUpdate}
          onClose={() => setShowLicence(false)}
        />
      )}
    </div>
  );
}

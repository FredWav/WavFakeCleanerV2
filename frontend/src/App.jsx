import { useState } from "react"
import { useStats } from "./hooks/useStats"
import { useWebSocket } from "./hooks/useWebSocket"
import { t, getStoredLang, setStoredLang } from "./lib/i18n"
import StatCards from "./components/StatCards"
import ControlPanel from "./components/ControlPanel"
import LogConsole from "./components/LogConsole"
import FollowerTable from "./components/FollowerTable"
import SettingsPanel from "./components/SettingsPanel"

export default function App() {
  const [lang, setLang] = useState(getStoredLang)
  const [showSettings, setShowSettings] = useState(false)
  const { stats, refresh } = useStats(3000)
  const { logs, connected, clearLogs } = useWebSocket(300)

  function toggleLang() {
    const next = lang === "fr" ? "en" : "fr"
    setLang(next)
    setStoredLang(next)
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
      {/* Header */}
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Wav Fake Cleaner V2</h1>
          <p className="text-sm text-gray-500">
            by{" "}
            <a
              href="https://www.threads.net/@fredwav"
              target="_blank"
              rel="noopener noreferrer"
              className="text-purple-400 hover:text-purple-300 transition-colors"
            >
              Fred Wav
            </a>
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <a
            href="https://www.threads.net/@fredwav"
            target="_blank"
            rel="noopener noreferrer"
            className="px-3 py-1.5 rounded-lg bg-purple-600 text-sm text-white
              hover:bg-purple-500 transition-colors font-medium"
          >
            {lang === "fr" ? "Faire un don" : "Donate"}
          </a>
          <button
            onClick={() => setShowSettings(true)}
            className="px-3 py-1.5 rounded-lg bg-gray-800 text-sm text-gray-400
              hover:text-white transition-colors"
            title={t("settings", lang)}
          >
            {t("settings", lang)}
          </button>
          <button
            onClick={toggleLang}
            className="px-3 py-1.5 rounded-lg bg-gray-800 text-sm text-gray-400
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

      {/* Two-column layout: Logs + Table */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <LogConsole
          logs={logs}
          connected={connected}
          onClear={clearLogs}
          lang={lang}
        />
        <FollowerTable lang={lang} refreshTrigger={stats?.scanned} />
      </div>

      {/* Settings modal */}
      {showSettings && (
        <SettingsPanel lang={lang} onClose={() => setShowSettings(false)} />
      )}
    </div>
  )
}

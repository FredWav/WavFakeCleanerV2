import { useState } from "react"
import { useStats } from "./hooks/useStats"
import { useWebSocket } from "./hooks/useWebSocket"
import { t, getStoredLang, setStoredLang } from "./lib/i18n"
import StatCards from "./components/StatCards"
import ControlPanel from "./components/ControlPanel"
import LogConsole from "./components/LogConsole"
import FollowerTable from "./components/FollowerTable"

export default function App() {
  const [lang, setLang] = useState(getStoredLang)
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
          <h1 className="text-2xl font-bold text-white">{t("title", lang)}</h1>
          <p className="text-sm text-gray-500">{t("subtitle", lang)}</p>
        </div>
        <button
          onClick={toggleLang}
          className="px-3 py-1.5 rounded-lg bg-gray-800 text-sm text-gray-400
            hover:text-white transition-colors"
        >
          {t("lang_toggle", lang)}
        </button>
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
    </div>
  )
}

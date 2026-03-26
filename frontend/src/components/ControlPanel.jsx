import { useState } from "react"
import { api } from "../lib/api"
import { t } from "../lib/i18n"

export default function ControlPanel({ stats, lang, onRefresh }) {
  const [loading, setLoading] = useState(null)
  const [error, setError] = useState(null)
  const isRunning = stats?.is_running

  async function run(action) {
    setLoading(action)
    setError(null)
    try {
      await api[action]()
      setTimeout(onRefresh, 500)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(null)
    }
  }

  const btn = (label, action, color) => (
    <button
      onClick={() => run(action)}
      disabled={loading || (isRunning && action !== "stop")}
      className={`px-4 py-2 rounded-lg font-medium text-sm transition-all
        ${isRunning && action !== "stop"
          ? "bg-gray-800 text-gray-600 cursor-not-allowed"
          : `${color} hover:brightness-110 active:scale-95`}
        ${loading === action ? "animate-pulse" : ""}`}
    >
      {t(label, lang)}
    </button>
  )

  return (
    <div className="space-y-3">
      <div className="flex gap-2 flex-wrap">
        {btn("fetch", "fetch", "bg-blue-600 text-white")}
        {btn("scan", "scan", "bg-cyan-600 text-white")}
        {btn("clean", "clean", "bg-orange-600 text-white")}
        {btn("autopilot", "autopilot", "bg-purple-600 text-white")}
        {isRunning && btn("stop", "stop", "bg-red-600 text-white")}
      </div>
      {error && (
        <div className="text-red-400 text-sm bg-red-500/10 rounded-lg px-3 py-2">
          {error}
        </div>
      )}
    </div>
  )
}

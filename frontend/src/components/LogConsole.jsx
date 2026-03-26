import { useEffect, useRef } from "react"
import { t } from "../lib/i18n"

const levelColors = {
  INFO: "text-blue-400",
  WARNING: "text-yellow-400",
  ERROR: "text-red-400",
  DEBUG: "text-gray-500",
}

function formatTs(iso) {
  if (!iso) return ""
  try {
    return new Date(iso).toLocaleTimeString()
  } catch {
    return ""
  }
}

export default function LogConsole({ logs, connected, onClear, lang }) {
  const bottomRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [logs.length])

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 flex flex-col h-80">
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-800">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${connected ? "bg-green-400" : "bg-red-400"}`} />
          <span className="text-sm font-medium">{t("logs", lang)}</span>
        </div>
        <button
          onClick={onClear}
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          {t("clear", lang)}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-3 font-mono text-xs space-y-0.5">
        {logs.length === 0 ? (
          <div className="text-gray-600 text-center mt-8">{t("no_logs", lang)}</div>
        ) : (
          logs.map((entry, i) => (
            <div key={i} className="flex gap-2 leading-5">
              <span className="text-gray-600 shrink-0">{formatTs(entry.ts)}</span>
              <span className={`shrink-0 w-12 ${levelColors[entry.level] || "text-gray-400"}`}>
                {entry.level}
              </span>
              <span className="text-gray-500 shrink-0">[{entry.category}]</span>
              <span className="text-gray-300">{entry.message}</span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}

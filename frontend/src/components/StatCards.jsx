import { t } from "../lib/i18n"

const cards = [
  { key: "total", color: "bg-blue-500/20 text-blue-400", field: "total_followers" },
  { key: "pending", color: "bg-yellow-500/20 text-yellow-400", field: "pending" },
  { key: "scanned", color: "bg-cyan-500/20 text-cyan-400", field: "scanned" },
  { key: "fakes", color: "bg-red-500/20 text-red-400", field: "fakes" },
  { key: "removed", color: "bg-green-500/20 text-green-400", field: "removed" },
]

export default function StatCards({ stats, lang }) {
  if (!stats) return null

  return (
    <div className="grid grid-cols-5 gap-3">
      {cards.map(({ key, color, field }) => (
        <div
          key={key}
          className={`rounded-xl p-4 ${color} backdrop-blur-sm`}
        >
          <div className="text-xs uppercase tracking-wider opacity-70">
            {t(key, lang)}
          </div>
          <div className="text-2xl font-bold mt-1">
            {stats[field]?.toLocaleString() ?? "—"}
          </div>
        </div>
      ))}

      {/* Rate info row */}
      {stats.rate && (
        <>
          <div className="rounded-xl p-3 bg-gray-800/50 col-span-2">
            <div className="flex justify-between text-sm">
              <span className="opacity-60">{t("actions_hour", lang)}</span>
              <span className="font-mono">
                {stats.rate.actions_this_hour}/{stats.rate.limit_hour ?? "—"}
              </span>
            </div>
            <div className="flex justify-between text-sm mt-1">
              <span className="opacity-60">{t("actions_today", lang)}</span>
              <span className="font-mono">
                {stats.rate.actions_today}/{stats.rate.limit_day ?? "—"}
              </span>
            </div>
          </div>
          <div className="rounded-xl p-3 bg-gray-800/50 col-span-2">
            <div className="flex justify-between text-sm">
              <span className="opacity-60">{t("errors", lang)}</span>
              <span className="font-mono">
                {stats.rate.consecutive_errors ?? 0}
              </span>
            </div>
            <div className="flex justify-between text-sm mt-1">
              <span className="opacity-60">{t("slowdown", lang)}</span>
              <span className="font-mono">
                {stats.rate.slowdown_factor ?? "1.0"}x
              </span>
            </div>
          </div>
          <div className="rounded-xl p-3 bg-gray-800/50 flex items-center justify-center">
            <span className={`text-sm font-bold ${stats.is_running ? "text-green-400" : "text-gray-500"}`}>
              {stats.is_running ? t("running", lang) : t("stopped", lang)}
            </span>
          </div>
        </>
      )}
    </div>
  )
}

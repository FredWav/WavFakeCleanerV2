import { useState, useEffect, useCallback } from "react"
import { api } from "../lib/api"
import { t } from "../lib/i18n"

const filters = [
  { key: "filter_all", param: "" },
  { key: "filter_pending", param: "status=pending" },
  { key: "filter_fake", param: "status=fake" },
  { key: "filter_removed", param: "status=removed" },
]

function scoreBadge(score) {
  if (score === null || score === undefined) return null
  let color = "bg-green-500/20 text-green-400"
  if (score >= 70) color = "bg-red-500/20 text-red-400"
  else if (score >= 40) color = "bg-yellow-500/20 text-yellow-400"
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-bold ${color}`}>
      {score}
    </span>
  )
}

function statusBadge(follower, lang) {
  if (follower.removed)
    return <span className="text-green-400 text-xs">{t("filter_removed", lang)}</span>
  if (follower.is_fake)
    return <span className="text-red-400 text-xs">{t("filter_fake", lang)}</span>
  if (follower.scanned)
    return <span className="text-cyan-400 text-xs">OK</span>
  return <span className="text-gray-500 text-xs">{t("filter_pending", lang)}</span>
}

export default function FollowerTable({ lang, refreshTrigger }) {
  const [followers, setFollowers] = useState([])
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState("")
  const [expanded, setExpanded] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = filter ? `${filter}&limit=200` : "limit=200"
      const data = await api.getFollowers(params)
      setFollowers(data)
    } catch {
      // silent
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => { load() }, [load, refreshTrigger])

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800">
      {/* Filter tabs */}
      <div className="flex gap-1 p-2 border-b border-gray-800">
        {filters.map(({ key, param }) => (
          <button
            key={key}
            onClick={() => setFilter(param)}
            className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors
              ${filter === param
                ? "bg-gray-700 text-white"
                : "text-gray-500 hover:text-gray-300"}`}
          >
            {t(key, lang)}
          </button>
        ))}
        <button
          onClick={load}
          className="ml-auto text-xs text-gray-500 hover:text-gray-300 px-2"
        >
          refresh
        </button>
      </div>

      {/* Table */}
      <div className="overflow-x-auto max-h-96 overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-gray-900">
            <tr className="text-gray-500 text-xs uppercase">
              <th className="text-left px-4 py-2">{t("follower", lang)}</th>
              <th className="text-center px-2 py-2">{t("score", lang)}</th>
              <th className="text-center px-2 py-2">{t("status", lang)}</th>
              <th className="text-left px-2 py-2">{t("breakdown", lang)}</th>
            </tr>
          </thead>
          <tbody>
            {loading && followers.length === 0 ? (
              <tr>
                <td colSpan={4} className="text-center py-8 text-gray-600">
                  {t("loading", lang)}
                </td>
              </tr>
            ) : followers.length === 0 ? (
              <tr>
                <td colSpan={4} className="text-center py-8 text-gray-600">
                  {t("no_data", lang)}
                </td>
              </tr>
            ) : (
              followers.map((f) => (
                <tr
                  key={f.username}
                  onClick={() => setExpanded(expanded === f.username ? null : f.username)}
                  className="border-t border-gray-800/50 hover:bg-gray-800/30 cursor-pointer transition-colors"
                >
                  <td className="px-4 py-2 font-mono text-gray-300">
                    @{f.username}
                    {f.is_private && (
                      <span className="ml-1 text-xs text-gray-600" title="Private">P</span>
                    )}
                  </td>
                  <td className="text-center px-2 py-2">
                    {scoreBadge(f.score)}
                  </td>
                  <td className="text-center px-2 py-2">
                    {statusBadge(f, lang)}
                  </td>
                  <td className="px-2 py-2 text-xs text-gray-500 max-w-xs truncate">
                    {expanded === f.username
                      ? f.score_breakdown
                      : f.score_breakdown
                        ? f.score_breakdown.substring(0, 50) + "..."
                        : "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

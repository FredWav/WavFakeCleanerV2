import { useState, useEffect, useCallback } from "react";
import { api } from "../lib/messaging";
import { t } from "../lib/i18n";
import type { FollowerRecord } from "@shared/types";

const filters = [
  { key: "filter_all", param: "" },
  { key: "filter_pending", param: "pending" },
  { key: "filter_ok", param: "ok" },
  { key: "filter_review", param: "review" },
  { key: "filter_fake", param: "fake" },
  { key: "filter_removed", param: "removed" },
];

function scoreBadge(score: number | null) {
  if (score === null || score === undefined) return null;
  let color = "bg-green-500/20 text-green-400";
  if (score >= 70) color = "bg-red-500/20 text-red-400";
  else if (score >= 40) color = "bg-yellow-500/20 text-yellow-400";
  return <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${color}`}>{score}</span>;
}

function statusBadge(f: FollowerRecord, lang: string) {
  if (f.removed) return <span className="text-green-400 text-[10px]">{t("filter_removed", lang)}</span>;
  if (f.toReview) return <span className="text-orange-400 text-[10px]">{t("to_review", lang)}</span>;
  if (f.approved) return <span className="text-emerald-400 text-[10px]">{t("approved", lang)}</span>;
  if (f.isFake) return <span className="text-red-400 text-[10px]">{t("filter_fake", lang)}</span>;
  if (f.scanned) return <span className="text-cyan-400 text-[10px]">OK</span>;
  return <span className="text-gray-500 text-[10px]">{t("filter_pending", lang)}</span>;
}

type FollowerWithUrl = FollowerRecord & { profile_url: string };

export default function FollowerTable({
  lang,
  refreshTrigger,
}: {
  lang: string;
  refreshTrigger?: number;
}) {
  const [followers, setFollowers] = useState<FollowerWithUrl[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getFollowers(filter || undefined, 200);
      setFollowers(data);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    load();
  }, [load, refreshTrigger]);

  async function handleApprove(e: React.MouseEvent, username: string) {
    e.stopPropagation();
    setActionLoading(username);
    try {
      await api.approveFollower(username);
      await load();
    } catch {
      // silent
    } finally {
      setActionLoading(null);
    }
  }

  async function handleReject(e: React.MouseEvent, username: string) {
    e.stopPropagation();
    setActionLoading(username);
    try {
      await api.rejectFollower(username);
      await load();
    } catch {
      // silent
    } finally {
      setActionLoading(null);
    }
  }

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800">
      <div className="flex gap-1 p-1.5 border-b border-gray-800 flex-wrap">
        {filters.map(({ key, param }) => (
          <button
            key={key}
            onClick={() => setFilter(param)}
            className={`px-2 py-0.5 rounded-lg text-[10px] font-medium transition-colors
              ${filter === param ? "bg-gray-700 text-white" : "text-gray-500 hover:text-gray-300"}`}
          >
            {t(key, lang)}
          </button>
        ))}
        <button onClick={load} className="ml-auto text-[10px] text-gray-500 hover:text-gray-300 px-1">
          refresh
        </button>
      </div>

      <div className="overflow-x-auto max-h-72 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-gray-900">
            <tr className="text-gray-500 text-[10px] uppercase">
              <th className="text-left px-2 py-1.5">{t("follower", lang)}</th>
              <th className="text-center px-1 py-1.5">{t("score", lang)}</th>
              <th className="text-center px-1 py-1.5">{t("status", lang)}</th>
            </tr>
          </thead>
          <tbody>
            {loading && followers.length === 0 ? (
              <tr>
                <td colSpan={3} className="text-center py-6 text-gray-600">
                  {t("loading", lang)}
                </td>
              </tr>
            ) : followers.length === 0 ? (
              <tr>
                <td colSpan={3} className="text-center py-6 text-gray-600">
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
                  <td className="px-2 py-1.5 font-mono text-gray-300">
                    <a
                      href={f.profile_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="text-purple-400 hover:text-purple-300 hover:underline transition-colors"
                    >
                      @{f.username}
                    </a>
                    {f.isPrivate && (
                      <span className="ml-1 text-[10px] text-gray-600" title="Private">
                        P
                      </span>
                    )}
                  </td>
                  <td className="text-center px-1 py-1.5">{scoreBadge(f.score)}</td>
                  <td className="text-center px-1 py-1.5">
                    <div className="flex items-center justify-center gap-1">
                      {statusBadge(f, lang)}
                      {f.toReview && !f.removed && !f.approved && (
                        <span className="inline-flex gap-0.5 ml-1">
                          <button
                            onClick={(e) => handleApprove(e, f.username)}
                            disabled={actionLoading === f.username}
                            className="px-1 py-0.5 rounded bg-green-600/30 text-green-400 text-[10px]
                              hover:bg-green-600/50 transition-colors disabled:opacity-50"
                          >
                            {t("approve", lang)}
                          </button>
                          <button
                            onClick={(e) => handleReject(e, f.username)}
                            disabled={actionLoading === f.username}
                            className="px-1 py-0.5 rounded bg-red-600/30 text-red-400 text-[10px]
                              hover:bg-red-600/50 transition-colors disabled:opacity-50"
                          >
                            {t("reject", lang)}
                          </button>
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

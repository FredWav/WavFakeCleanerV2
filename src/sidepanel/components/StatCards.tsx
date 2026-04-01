import { t } from "../lib/i18n";
import type { Stats } from "@shared/types";

const cards = [
  { key: "total", color: "bg-blue-500/20 text-blue-400", field: "totalFollowers" as const },
  { key: "pending", color: "bg-yellow-500/20 text-yellow-400", field: "pending" as const },
  { key: "scanned", color: "bg-cyan-500/20 text-cyan-400", field: "scanned" as const },
  { key: "fakes", color: "bg-red-500/20 text-red-400", field: "fakes" as const },
  { key: "to_review", color: "bg-orange-500/20 text-orange-400", field: "toReview" as const },
  { key: "removed", color: "bg-green-500/20 text-green-400", field: "removed" as const },
];

export default function StatCards({ stats, lang }: { stats: Stats | null; lang: string }) {
  if (!stats) return null;

  return (
    <div className="grid grid-cols-3 gap-2">
      {cards.map(({ key, color, field }) => (
        <div key={key} className={`rounded-xl p-3 ${color} backdrop-blur-sm`}>
          <div className="text-[10px] uppercase tracking-wider opacity-70">{t(key, lang)}</div>
          <div className="text-xl font-bold mt-0.5">
            {stats[field]?.toLocaleString() ?? "\u2014"}
          </div>
        </div>
      ))}

      {stats.rate && (
        <>
          <div className="rounded-xl p-2 bg-gray-800/50 col-span-2">
            <div className="flex justify-between text-xs">
              <span className="opacity-60">{t("actions_hour", lang)}</span>
              <span className="font-mono">
                {stats.rate.actionsThisHour}/{stats.rate.limitHour}
              </span>
            </div>
            <div className="flex justify-between text-xs mt-1">
              <span className="opacity-60">{t("actions_today", lang)}</span>
              <span className="font-mono">
                {stats.rate.actionsToday}/{stats.rate.limitDay}
              </span>
            </div>
          </div>
          <div className="rounded-xl p-2 bg-gray-800/50 flex items-center justify-center">
            <span
              className={`text-xs font-bold ${stats.isRunning ? "text-green-400" : "text-gray-500"}`}
            >
              {stats.isRunning ? t("running", lang) : t("stopped", lang)}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

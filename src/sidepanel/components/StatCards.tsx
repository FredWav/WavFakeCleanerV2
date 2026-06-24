import { t } from "../lib/i18n";
import { useCountUp } from "../hooks/useCountUp";
import type { Stats } from "@shared/types";
import Skeleton from "./ui/Skeleton";

const cards = [
  { key: "total", color: "bg-blue-500/20 text-blue-400", field: "totalFollowers" as const },
  { key: "pending", color: "bg-yellow-500/20 text-yellow-400", field: "pending" as const },
  { key: "scanned", color: "bg-cyan-500/20 text-cyan-400", field: "scanned" as const },
  { key: "fakes", color: "bg-red-500/20 text-red-400", field: "fakes" as const },
  { key: "to_review", color: "bg-orange-500/20 text-orange-400", field: "toReview" as const },
  { key: "removed", color: "bg-green-500/20 text-green-400", field: "removed" as const },
];

function AnimatedCard({ value, color, label }: { value: number; color: string; label: string }) {
  const display = useCountUp(value);
  return (
    <div className={`rounded-xl p-3 ${color} backdrop-blur-sm`}>
      <div className="text-[11px] uppercase tracking-wider opacity-70">{label}</div>
      <div className="text-xl font-bold mt-0.5">{display.toLocaleString()}</div>
    </div>
  );
}

function HealthGauge({ score, coverage, lang }: { score: number | null; coverage: number; lang: string }) {
  const display = useCountUp(score ?? 0);
  const radius = 35;
  const circumference = 2 * Math.PI * radius;
  const hasScore = score !== null;
  // Empty (full-offset) ring in neutral grey until the first scan produces data,
  // so a fresh, healthy account never shows an alarming red "0 / 100".
  const offset = hasScore ? circumference * (1 - display / 100) : circumference;
  const color = !hasScore ? "#4b5563" : display > 80 ? "#22c55e" : display > 50 ? "#eab308" : "#ef4444";
  const bgColor = !hasScore ? "text-gray-500" : display > 80 ? "text-green-400" : display > 50 ? "text-yellow-400" : "text-red-400";

  return (
    <div className="flex flex-col items-center mb-2">
      <svg width="80" height="80" viewBox="0 0 90 90">
        <circle
          cx="45" cy="45" r={radius}
          fill="none" stroke="#1f2937" strokeWidth="6"
        />
        <circle
          cx="45" cy="45" r={radius}
          fill="none" stroke={color} strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform="rotate(-90 45 45)"
          className="transition-all duration-700 ease-out"
        />
        <text
          x="45" y="42" textAnchor="middle" dominantBaseline="middle"
          className={`text-lg font-bold ${bgColor}`}
          fill="currentColor" fontSize="18"
        >
          {hasScore ? display : "—"}
        </text>
        <text
          x="45" y="56" textAnchor="middle"
          fill="#6b7280" fontSize="8"
        >
          {hasScore ? "/ 100" : ""}
        </text>
      </svg>
      <span className="text-[11px] text-gray-500 -mt-1">{t("health_score", lang)}</span>
      {coverage > 0 && coverage < 100 && (
        <span className="text-[11px] text-gray-600">
          {t("scanned_coverage", lang).replace("{0}", String(coverage))}
        </span>
      )}
    </div>
  );
}

export default function StatCards({
  stats,
  lang,
  communityTotal,
}: {
  stats: Stats | null;
  lang: string;
  communityTotal?: number | null;
}) {
  // First paint before the first GET_STATS answer: keep the layout stable
  // with skeletons instead of a blank gap.
  if (!stats) {
    return (
      <div className="space-y-2">
        <div className="flex flex-col items-center mb-2">
          <Skeleton className="w-20 h-20 rounded-full" />
        </div>
        <div className="grid grid-cols-3 gap-2">
          {cards.map(({ key }) => (
            <Skeleton key={key} className="h-[60px] rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  // Health = share of EVALUATED profiles that turned out genuinely OK.
  // Based on the scanned population (not /total), so a partial scan of a healthy
  // account no longer reads as "0/100 red". Stays neutral ("—") until the first
  // scan, and coverage (scanned/total) is shown separately below the gauge.
  const total = stats.totalFollowers ?? 0;
  const scannedCount = stats.scanned ?? 0;
  const removed = stats.removed ?? 0;
  // OK profiles = scanned minus the ones flagged fake / to-review / already removed.
  const clean = Math.max(0, scannedCount - (stats.fakes ?? 0) - (stats.toReview ?? 0) - removed);
  const evaluated = scannedCount;
  const healthScore = evaluated > 0 ? Math.min(100, Math.round((clean / evaluated) * 100)) : null;
  const coverage = total > 0 ? Math.min(100, Math.round((evaluated / total) * 100)) : 0;

  // Extrapole la proportion de faux de l'échantillon scanné à tout le compte,
  // pour qu'un scan partiel donne déjà une idée de l'ampleur. Affiché seulement si
  // on a un vrai échantillon, des faux, et que le scan n'est pas déjà terminé.
  const fakesCount = stats.fakes ?? 0;
  const estimatedFakes =
    evaluated > 0 && fakesCount > 0 && total > evaluated
      ? Math.round((fakesCount / evaluated) * total)
      : null;

  return (
    <div className="space-y-2">
      <HealthGauge score={healthScore} coverage={coverage} lang={lang} />

      {estimatedFakes !== null && (
        <p className="text-[11px] text-red-300/90 text-center bg-red-500/5 rounded-lg px-2 py-1 leading-snug">
          {t("fakes_estimate", lang)
            .replace("{0}", estimatedFakes.toLocaleString())
            .replace("{1}", total.toLocaleString())}
        </p>
      )}

      <div className="grid grid-cols-3 gap-2">
        {cards.map(({ key, color, field }) => (
          <AnimatedCard
            key={key}
            value={stats[field] ?? 0}
            color={color}
            label={t(key, lang)}
          />
        ))}

      </div>

      {typeof communityTotal === "number" && communityTotal > 0 && (
        <p className="text-[11px] text-blue-400/90 text-center leading-snug">
          {t("community_total_banner", lang).replace("{0}", communityTotal.toLocaleString())}
        </p>
      )}
    </div>
  );
}

import { t } from "../lib/i18n";
import { useCountUp } from "../hooks/useCountUp";
import type { Stats } from "@shared/types";
import Skeleton from "./ui/Skeleton";

// Lot 3 — hiérarchie de l'information. Plus d'arc-en-ciel de 6 cartes de poids
// égal mélangeant KPI et tuyauterie (« En attente »/« Analysés »). La jauge de
// santé reste le repère premium ; en dessous, une bande CONTEXTE discrète et
// neutre (fond encre, chiffre blanc, label gris) sur les 3 seuls états qui
// parlent à un créateur : faux, à vérifier, supprimés. Le total et le nombre
// analysés vivent déjà dans la barre de progression et le bilan héros — plus de
// doublon, plus de rouge redondant (l'ancienne « Estimation ~X faux » a sauté).

function StatCell({ value, label, tone }: { value: number; label: string; tone?: "danger" }) {
  const display = useCountUp(value);
  // Une seule couleur d'exception : le nombre de faux vire au rouge quand il y
  // en a. Tout le reste reste neutre pour ne pas concurrencer l'œil.
  const numColor = tone === "danger" && value > 0 ? "text-red-400" : "text-white";
  return (
    <div className="rounded-xl bg-gray-900/60 border border-gray-800 px-2 py-3 text-center">
      <div className={`text-2xl font-bold tabular-nums ${numColor}`}>{display.toLocaleString()}</div>
      <div className="text-xs text-gray-500 mt-0.5">{label}</div>
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
      <span className="text-xs text-gray-500 -mt-1">{t("health_score", lang)}</span>
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
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[64px] rounded-xl" />
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

  return (
    <div className="space-y-2">
      <HealthGauge score={healthScore} coverage={coverage} lang={lang} />

      <div className="grid grid-cols-3 gap-2">
        <StatCell value={stats.fakes ?? 0} label={t("fakes", lang)} tone="danger" />
        <StatCell value={stats.toReview ?? 0} label={t("to_review", lang)} />
        <StatCell value={stats.removed ?? 0} label={t("removed", lang)} />
      </div>

      {typeof communityTotal === "number" && communityTotal > 0 && (
        <p className="text-[11px] text-gray-500 text-center leading-snug">
          {t("community_total_banner", lang).replace("{0}", communityTotal.toLocaleString())}
        </p>
      )}
    </div>
  );
}

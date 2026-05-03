import { t } from "../lib/i18n";
import { useCountUp } from "../hooks/useCountUp";
import type { Stats } from "@shared/types";

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
      <div className="text-[10px] uppercase tracking-wider opacity-70">{label}</div>
      <div className="text-xl font-bold mt-0.5">{display.toLocaleString()}</div>
    </div>
  );
}

function HealthGauge({ score, lang }: { score: number; lang: string }) {
  const display = useCountUp(score);
  const radius = 35;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - display / 100);
  const color = display > 80 ? "#22c55e" : display > 50 ? "#eab308" : "#ef4444";
  const bgColor = display > 80 ? "text-green-400" : display > 50 ? "text-yellow-400" : "text-red-400";

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
          {display}
        </text>
        <text
          x="45" y="56" textAnchor="middle"
          fill="#6b7280" fontSize="8"
        >
          / 100
        </text>
      </svg>
      <span className="text-[10px] text-gray-500 -mt-1">{t("health_score", lang)}</span>
    </div>
  );
}

export default function StatCards({ stats, lang }: { stats: Stats | null; lang: string }) {
  if (!stats) return null;

  // (scannés propres + supprimés) / total × 100
  // Scannés propres = scanned - fakes - toReview (ceux validés OK)
  // Monte de 0 vers 100 au fur et à mesure qu'on scanne et nettoie
  const total = stats.totalFollowers ?? 0;
  const clean = Math.max(0, (stats.scanned ?? 0) - (stats.fakes ?? 0) - (stats.toReview ?? 0));
  const healthScore = total > 0
    ? Math.max(0, Math.min(100, Math.round((clean + (stats.removed ?? 0)) / total * 100)))
    : 0;

  return (
    <div className="space-y-2">
      <HealthGauge score={healthScore} lang={lang} />

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
    </div>
  );
}

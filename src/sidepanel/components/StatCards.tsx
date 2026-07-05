import { t } from "../lib/i18n";
import { useCountUp } from "../hooks/useCountUp";
import type { Stats } from "@shared/types";
import Skeleton from "./ui/Skeleton";
import Waveform from "./Waveform";

// Refonte « signal ». Plus de jauge SVG ni d'arc-en-ciel de cartes : une
// waveform de marque (le clin d'œil « Wav ») porte l'état de santé, doublée
// d'une légende chiffrée, puis une bande contexte neutre à 3 cellules (Faux /
// À vérifier / Supprimés). Une seule couleur d'exception : les faux en rouge.

function StatCell({ value, label, tone }: { value: number; label: string; tone?: "danger" }) {
  const display = useCountUp(value);
  const numColor = tone === "danger" && value > 0 ? "text-suspect" : "text-ink";
  return (
    <div className="rounded-xl bg-surface border border-line px-2 py-3 text-center">
      <div className={`text-2xl font-bold tabular-nums ${numColor}`}>{display.toLocaleString()}</div>
      <div className="text-xs text-ink-faint mt-0.5">{label}</div>
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
  if (!stats) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-[92px] rounded-2xl" />
        <div className="grid grid-cols-3 gap-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[64px] rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  // Santé = part des profils ÉVALUÉS qui se révèlent authentiques. Basé sur la
  // population scannée (pas /total) : un scan partiel d'un compte sain ne lit
  // plus « 0/100 ». Reste « — » tant qu'aucun scan.
  const total = stats.totalFollowers ?? 0;
  const scannedCount = stats.scanned ?? 0;
  const removed = stats.removed ?? 0;
  const clean = Math.max(0, scannedCount - (stats.fakes ?? 0) - (stats.toReview ?? 0) - removed);
  const healthScore = scannedCount > 0 ? Math.min(100, Math.round((clean / scannedCount) * 100)) : null;

  return (
    <div className="space-y-3">
      {/* Signal d'authenticité — la waveform de marque + la légende chiffrée. */}
      <div className="rounded-2xl bg-surface-2 border border-line px-4 py-3.5">
        <Waveform />
        <div className="flex items-center gap-2 mt-3 text-xs text-ink-soft">
          <span className="w-[7px] h-[7px] rounded-full bg-clean ring-4 ring-clean-bg shrink-0" />
          {healthScore !== null ? (
            <span>
              <b className="text-ink font-bold tabular-nums">{healthScore}%</b> {t("signal_authentic", lang)}
            </span>
          ) : (
            <span>{t("signal_pending", lang)}</span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <StatCell value={stats.fakes ?? 0} label={t("fakes", lang)} tone="danger" />
        <StatCell value={stats.toReview ?? 0} label={t("to_review", lang)} />
        <StatCell value={removed} label={t("removed", lang)} />
      </div>

      {typeof communityTotal === "number" && communityTotal > 0 && (
        <p className="text-[11px] text-ink-faint text-center leading-snug">
          {t("community_total_banner", lang).replace("{0}", communityTotal.toLocaleString())}
        </p>
      )}
    </div>
  );
}

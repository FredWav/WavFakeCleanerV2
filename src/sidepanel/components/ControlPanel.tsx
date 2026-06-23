import { useState, useEffect } from "react";
import { api } from "../lib/messaging";
import { t } from "../lib/i18n";
import type { Stats, LicenseInfo } from "@shared/types";
import Modal from "./ui/Modal";

// Au-delà de ce nombre de suppressions, on exige une case « j'ai compris »
// explicite avant d'activer le bouton de confirmation (U-C1).
const CONFIRM_ACK_THRESHOLD = 20;

function formatMMSS(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/**
 * Live countdown shown while the pipeline is in a long anti-block pause (hard
 * 429, error-page cooldown, mandatory session break, between-cycle pause).
 * Without it the progress bar just looks frozen for minutes/hours.
 */
function PauseBanner({ until, reason, lang, removed }: { until: number; reason: string | null; lang: string; removed: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const remaining = until - now;
  const reasonLabel = reason ? t(`pause_reason_${reason}`, lang) : "";
  return (
    <div className="text-amber-300 text-xs bg-amber-500/10 border border-amber-500/20 rounded-lg px-2 py-1.5 leading-snug">
      <div className="font-semibold">
        {t("pause_title", lang)}
        {reasonLabel ? <span className="font-normal opacity-80"> · {reasonLabel}</span> : null}
      </div>
      <div className="opacity-90 tabular-nums">
        {remaining > 0
          ? t("pause_resume_in", lang).replace("{0}", formatMMSS(remaining))
          : t("running", lang)}
      </div>
      {/* Présente une longue pause comme une protection voulue, pas un blocage,
          et montre le travail déjà fait pour que l'attente paraisse méritée. */}
      <div className="mt-1 font-normal opacity-80">{t("pause_reassure", lang)}</div>
      {removed > 0 && (
        <div className="font-normal opacity-80">
          {t("pause_progress_so_far", lang).replace("{0}", removed.toLocaleString())}
        </div>
      )}
    </div>
  );
}

export default function ControlPanel({
  stats,
  lang,
  licence,
  onRefresh,
}: {
  stats: Stats | null;
  lang: string;
  licence: LicenseInfo;
  onRefresh: () => void;
}) {
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  // U-C1 : aucune suppression irréversible sans une étape de confirmation
  // explicite (nombre exact, échantillon des @, rappel du caractère définitif).
  const [confirm, setConfirm] = useState<
    null | { action: "removeFakes" | "clean" | "continuous"; count: number; sample: string[] }
  >(null);
  const [ack, setAck] = useState(false);
  const isRunning = stats?.isRunning;
  // Faux flaggés encore présents (pas encore supprimés) — le compteur de
  // l'étape explicite « Supprimer les faux » après une analyse.
  const fakesToRemove = stats?.fakes ?? 0;

  async function run(action: string) {
    setLoading(action);
    setError(null);
    try {
      const fn = api[action as keyof typeof api] as () => Promise<unknown>;
      await fn();
      setTimeout(onRefresh, 500);
    } catch (e) {
      console.error("[WFC] action failed:", e);
      setError(t("action_failed", lang));
    } finally {
      setLoading(null);
    }
  }

  // Ouvre la modale de confirmation pour la suppression explicite des faux
  // flaggés. Récupère un échantillon des @ concernés pour que l'utilisateur
  // voie QUI va partir avant de confirmer.
  async function requestRemoveFakes() {
    let sample: string[] = [];
    try {
      const fakes = await api.getFollowers("fake", 8);
      sample = fakes.map((f) => f.username);
    } catch {
      // échantillon best-effort — la confirmation reste possible sans
    }
    setAck(false);
    setConfirm({ action: "removeFakes", count: fakesToRemove, sample });
  }

  // For licensed users, "Nettoyer" launches continuous mode. Les deux variantes
  // suppriment → confirmation obligatoire aussi.
  function handleClean() {
    setAck(false);
    setConfirm({
      action: licence.active ? "continuous" : "clean",
      count: fakesToRemove,
      sample: [],
    });
  }

  // Confirme l'action destructive en attente et la lance réellement.
  function confirmProceed() {
    const action = confirm?.action;
    setConfirm(null);
    setAck(false);
    if (action) run(action);
  }

  const progress = stats && stats.totalFollowers > 0
    ? Math.min(100, Math.round((stats.scanned / stats.totalFollowers) * 100))
    : 0;

  return (
    <div className="space-y-2">
      {/* Réassurance permanente : les vrais abonnés ne sont jamais touchés. Calme
          la peur n°1 qui bloque l'usage et la conversion. */}
      <p className="text-[10px] text-green-300/90 bg-green-500/5 border border-green-500/10 rounded-lg px-2 py-1.5 leading-snug">
        {t("safety_promise", lang)}
      </p>

      {/* Flux débutant principal : UN bouton qui récupère + analyse et ne supprime
          JAMAIS. La suppression est une 2e étape explicite et vérifiable, plus bas. */}
      <button
        onClick={() => run("analyze")}
        disabled={!!loading || !!isRunning}
        className={`w-full px-3 py-2.5 rounded-lg font-bold text-sm transition-all
          ${isRunning
            ? "bg-gray-800 text-gray-600 cursor-not-allowed"
            : "bg-purple-600 text-white hover:bg-purple-500 active:scale-95"
          }
          ${loading === "analyze" ? "animate-pulse" : ""}`}
      >
        {t("analyze_btn", lang)}
      </button>
      <p className="text-[10px] text-gray-500 leading-snug">{t("analyze_hint", lang)}</p>

      {/* Étape 2 : supprime UNIQUEMENT les faux flaggés que l'utilisateur a vus et validés. */}
      {!isRunning && fakesToRemove > 0 && (
        <button
          onClick={requestRemoveFakes}
          disabled={!!loading}
          className={`w-full px-3 py-2 rounded-lg font-medium text-sm transition-all
            bg-red-600/90 text-white hover:bg-red-500 active:scale-95`}
        >
          {t("remove_fakes_btn", lang)} ({fakesToRemove.toLocaleString()})
        </button>
      )}

      <button
        onClick={() => run("stop")}
        disabled={!!loading || !isRunning}
        className={`w-full px-3 py-2 rounded-lg font-medium text-sm transition-all
          ${isRunning
            ? "bg-red-600 text-white hover:bg-red-500 active:scale-95 animate-pulse"
            : "bg-gray-800 text-gray-600 cursor-not-allowed"
          }`}
      >
        {isRunning ? t("stop", lang) : t("stopped", lang)}
      </button>

      {/* Avancé : contrôles manuels d'origine en 2 temps (utilisateurs avertis /
          mode continu payant). Masqués par défaut pour garder le flux débutant clair. */}
      <button
        onClick={() => setShowAdvanced((v) => !v)}
        className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors"
      >
        {showAdvanced ? "▾ " : "▸ "}{t("advanced_toggle", lang)}
      </button>
      {showAdvanced && (
        <div className="flex gap-2">
          <button
            onClick={() => run("fetch")}
            disabled={!!loading || !!isRunning}
            className={`flex-1 px-3 py-2 rounded-lg font-medium text-sm transition-all
              ${isRunning
                ? "bg-gray-800 text-gray-600 cursor-not-allowed"
                : "bg-blue-600 text-white hover:bg-blue-500 active:scale-95"
              }
              ${loading === "fetch" ? "animate-pulse" : ""}`}
          >
            {t("fetch", lang)}
          </button>
          <button
            onClick={handleClean}
            disabled={!!loading || !!isRunning}
            className={`flex-1 px-3 py-2 rounded-lg font-medium text-sm transition-all
              ${isRunning
                ? "bg-gray-800 text-gray-600 cursor-not-allowed"
                : "bg-purple-600 text-white hover:bg-purple-500 active:scale-95"
              }
              ${loading === "clean" || loading === "continuous" ? "animate-pulse" : ""}`}
          >
            {t("clean_btn", lang)}
            {licence.active && (
              <span className="ml-1 text-[10px] opacity-70">{t("continuous_label", lang)}</span>
            )}
          </button>
        </div>
      )}

      {/* Anti-block pause countdown (explains why the bar is frozen) */}
      {isRunning && stats?.pausedUntil ? (
        <PauseBanner
          until={stats.pausedUntil}
          reason={stats.pauseReason ?? null}
          lang={lang}
          removed={stats.removed ?? 0}
        />
      ) : null}

      {/* Pendant l'exécution : dire à l'utilisateur qu'il peut partir — le scan
          continue dans un onglet de fond. Évite de fixer la barre pendant 20 min. */}
      {isRunning && (
        <p className="text-[10px] text-gray-500 leading-snug">{t("running_background_hint", lang)}</p>
      )}

      {/* Progress bar */}
      {isRunning && stats && stats.totalFollowers > 0 && (
        <div className="space-y-1">
          <div className="flex justify-between text-[10px] text-gray-500">
            <span>{t("progress_label", lang)}</span>
            <span>{progress}%</span>
          </div>
          <div className="w-full h-1.5 bg-gray-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-purple-600 rounded-full transition-all duration-700 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {error && (
        <div className="text-red-400 text-xs bg-red-500/10 rounded-lg px-2 py-1">{error}</div>
      )}

      {/* Pipeline-level error from the last fetch/clean run. Distinct from the
          local action error above (which only covers api.* failures). */}
      {!error && !isRunning && stats?.lastError && (
        <div className="text-red-400 text-xs bg-red-500/10 rounded-lg px-2 py-1.5 leading-snug">
          {stats.lastError}
        </div>
      )}

      {/* Persistent honesty note: fetching is scroll-based and caps ~5000/pass. */}
      <p className="text-[10px] text-gray-500 leading-snug">{t("fetch_limit_note", lang)}</p>

      {/* Rendre les limites du plan gratuit visibles d'emblée, pas en mur surprise. */}
      {!licence.active && (
        <p className="text-[10px] text-gray-500 leading-snug">{t("free_plan_note", lang)}</p>
      )}

      {/* U-C1 : confirmation obligatoire avant toute suppression irréversible. */}
      {confirm && (() => {
        const ackRequired =
          confirm.action === "continuous" || confirm.count >= CONFIRM_ACK_THRESHOLD;
        const title =
          confirm.action === "removeFakes"
            ? t("confirm_remove_title", lang).replace("{0}", confirm.count.toLocaleString())
            : confirm.action === "continuous"
              ? t("confirm_continuous_title", lang)
              : t("confirm_clean_title", lang);
        const body =
          confirm.action === "removeFakes"
            ? t("confirm_remove_body", lang)
            : confirm.action === "continuous"
              ? t("confirm_continuous_body", lang)
              : t("confirm_clean_body", lang);
        const close = () => { setConfirm(null); setAck(false); };
        return (
          <Modal onClose={close}>
            <h3 className="text-sm font-bold text-white">{title}</h3>
            <p className="text-xs text-gray-300 leading-snug">{body}</p>
            {confirm.sample.length > 0 && (
              <p className="text-[11px] text-gray-400 leading-snug break-words">
                {t("confirm_remove_sample", lang).replace(
                  "{0}",
                  confirm.sample.map((u) => "@" + u).join(", "),
                )}
                {confirm.count > confirm.sample.length ? " …" : ""}
              </p>
            )}
            {ackRequired && (
              <label className="flex items-start gap-2 text-xs text-gray-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={(e) => setAck(e.target.checked)}
                  className="mt-0.5 accent-red-600"
                />
                <span>{t("confirm_remove_ack", lang)}</span>
              </label>
            )}
            <div className="flex gap-2 pt-1">
              <button
                onClick={close}
                className="flex-1 px-3 py-2 rounded-lg text-sm font-medium bg-gray-800 text-gray-200 hover:bg-gray-700 active:scale-95 transition-all"
              >
                {t("confirm_cancel", lang)}
              </button>
              <button
                onClick={confirmProceed}
                disabled={ackRequired && !ack}
                className={`flex-1 px-3 py-2 rounded-lg text-sm font-bold transition-all
                  ${ackRequired && !ack
                    ? "bg-gray-800 text-gray-600 cursor-not-allowed"
                    : "bg-red-600 text-white hover:bg-red-500 active:scale-95"}`}
              >
                {t("confirm_remove_confirm", lang)}
              </button>
            </div>
          </Modal>
        );
      })()}
    </div>
  );
}

import { useState, useEffect, useRef } from "react";
import { api } from "../lib/messaging";
import { t } from "../lib/i18n";
import { FREE_LIMITS, type Stats, type LicenseInfo } from "@shared/types";
import Modal from "./ui/Modal";
import { IconChevronDown, IconChevronRight } from "./Icons";

// Au-delà de ce nombre de suppressions, on exige une case « j'ai compris »
// explicite avant d'activer le bouton de confirmation (U-C1).
const CONFIRM_ACK_THRESHOLD = 20;

function formatMMSS(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

// ETA lisible : au-delà de 90s on arrondit en minutes (« ~25 min »), sinon mm:ss.
function formatEta(ms: number, lang: string): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 90) return formatMMSS(ms);
  return t("eta_minutes", lang).replace("{0}", String(Math.round(totalSec / 60)));
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

/**
 * Bandeau de suppression différée (U-H1) : compte à rebours avant l'exécution,
 * avec un bouton « Annuler » bien visible. Donne le filet de sécurité réclamé
 * sans dépendre d'un undo côté Threads (impossible).
 */
function PendingDeleteBanner({
  until, count, lang, onCancel,
}: { until: number; count: number; lang: string; onCancel: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  const secs = Math.max(0, Math.ceil((until - now) / 1000));
  return (
    <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-2 py-1.5">
      <span className="flex-1 text-xs text-red-200 leading-snug">
        {t("pending_delete", lang)
          .replace("{0}", count.toLocaleString())
          .replace("{1}", String(secs))}
      </span>
      <button
        onClick={onCancel}
        className="shrink-0 px-2 py-1 rounded-lg text-xs font-bold bg-gray-800 text-white hover:bg-gray-700 active:scale-95 transition-all"
      >
        {t("cancel_delete", lang)}
      </button>
    </div>
  );
}

export default function ControlPanel({
  stats,
  lang,
  licence,
  onRefresh,
  fakeSelection = null,
  username = "",
  onOpenSettings,
}: {
  stats: Stats | null;
  lang: string;
  licence: LicenseInfo;
  onRefresh: () => void;
  // U-C2 : sélection explicite des faux à supprimer (cases cochées dans la
  // table). null = pas de sélection active → on supprime tous les faux flaggés.
  fakeSelection?: string[] | null;
  // Lot 1 : @ requis pour lancer le scan. Vide → « Analyser » bloqué + micro-copie.
  username?: string;
  onOpenSettings?: () => void;
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
  // U-H1 : suppression différée annulable (le vrai « undo » est impossible —
  // Threads ne réajoute pas un abonné — donc on offre une fenêtre AVANT exécution).
  const [pendingDelete, setPendingDelete] = useState<
    null | { usernames: string[] | null; count: number; until: number }
  >(null);
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isRunning = stats?.isRunning;
  // Faux flaggés encore présents (pas encore supprimés). Si une sélection est
  // active (cases cochées), c'est elle qui pilote le compteur et la suppression.
  const selectionActive = Array.isArray(fakeSelection);
  const fakesToRemove = selectionActive ? fakeSelection!.length : (stats?.fakes ?? 0);
  // Lot 1 : préalable @ obligatoire — bloque « Analyser » et calme l'échec
  // silencieux (un run sans @ partait sur un compte vide).
  const needsUsername = !username.trim();
  const analyzeBlocked = !!isRunning || needsUsername;

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
  // voie QUI va partir avant de confirmer (la sélection si active, sinon la DB).
  async function requestRemoveFakes() {
    let sample: string[] = [];
    if (selectionActive) {
      sample = fakeSelection!.slice(0, 8);
    } else {
      try {
        const fakes = await api.getFollowers("fake", 8);
        sample = fakes.map((f) => f.username);
      } catch {
        // échantillon best-effort — la confirmation reste possible sans
      }
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

  // Lance la suppression différée (U-H1) : fenêtre de 8s annulable, puis exécution.
  function startDeferredDelete(usernames: string[] | null, count: number) {
    if (pendingTimer.current) clearTimeout(pendingTimer.current);
    setPendingDelete({ usernames, count, until: Date.now() + 8000 });
    pendingTimer.current = setTimeout(() => {
      pendingTimer.current = null;
      setPendingDelete(null);
      void runRemove(usernames);
    }, 8000);
  }

  function cancelDeferredDelete() {
    if (pendingTimer.current) clearTimeout(pendingTimer.current);
    pendingTimer.current = null;
    setPendingDelete(null);
  }

  async function runRemove(usernames: string[] | null) {
    setLoading("removeFakes");
    setError(null);
    try {
      await api.removeFakes(usernames ?? undefined);
      setTimeout(onRefresh, 500);
    } catch (e) {
      console.error("[WFC] removeFakes failed:", e);
      setError(t("action_failed", lang));
    } finally {
      setLoading(null);
    }
  }

  // Nettoie le timer si le composant est démonté pendant l'attente.
  useEffect(() => () => { if (pendingTimer.current) clearTimeout(pendingTimer.current); }, []);

  // U-H6 : compteur de consommation quotidienne du plan gratuit. Rafraîchi quand
  // l'état de run change (un cycle vient de se terminer) ou la licence.
  const [cyclesToday, setCyclesToday] = useState<number | null>(null);
  useEffect(() => {
    if (licence.active) { setCyclesToday(null); return; }
    let cancelled = false;
    api.getDailyUsage()
      .then((u) => { if (!cancelled) setCyclesToday(u.cycles); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [licence.active, isRunning]);

  // Confirme l'action en attente. La suppression explicite passe par la file
  // différée annulable ; le nettoyage/continu (scan + suppression) démarre direct.
  function confirmProceed() {
    const c = confirm;
    setConfirm(null);
    setAck(false);
    if (!c) return;
    if (c.action === "removeFakes") {
      startDeferredDelete(selectionActive ? fakeSelection! : null, c.count);
    } else {
      run(c.action);
    }
  }

  const scanned = stats?.scanned ?? 0;
  const totalFollowers = stats?.totalFollowers ?? 0;
  const progress = totalFollowers > 0
    ? Math.min(100, Math.round((scanned / totalFollowers) * 100))
    : 0;

  // U-H4 : ETA basée sur le débit MOYEN depuis le début du run en cours (stable,
  // contrairement à un débit instantané qui sauterait à chaque tick de 3s).
  const runStartRef = useRef<{ scanned: number; ts: number } | null>(null);
  const [etaMs, setEtaMs] = useState<number | null>(null);
  useEffect(() => {
    if (!isRunning) { runStartRef.current = null; setEtaMs(null); return; }
    const now = Date.now();
    if (!runStartRef.current) { runStartRef.current = { scanned, ts: now }; return; }
    const start = runStartRef.current;
    const done = scanned - start.scanned;
    const elapsed = now - start.ts;
    if (done > 0 && elapsed > 0) {
      const rate = done / elapsed; // profils par ms
      const remaining = Math.max(0, totalFollowers - scanned);
      setEtaMs(rate > 0 ? remaining / rate : null);
    }
  }, [scanned, totalFollowers, isRunning]);

  return (
    <div className="space-y-2">
      {/* Réassurance permanente : les vrais abonnés ne sont jamais touchés. Calme
          la peur n°1 qui bloque l'usage et la conversion. */}
      <p className="text-[11px] text-green-300/90 bg-green-500/5 border border-green-500/10 rounded-lg px-2 py-1.5 leading-snug">
        {t("safety_promise", lang)}
      </p>

      {/* Flux débutant principal : UN bouton qui récupère + analyse et ne supprime
          JAMAIS. La suppression est une 2e étape explicite et vérifiable, plus bas. */}
      <button
        onClick={() => run("analyze")}
        disabled={!!loading || analyzeBlocked}
        className={`w-full px-3 py-2.5 rounded-lg font-bold text-sm transition-all
          ${analyzeBlocked
            ? "bg-gray-800 text-gray-600 cursor-not-allowed"
            : "bg-accent text-accent-ink hover:bg-accent-hover active:scale-95"
          }
          ${loading === "analyze" ? "opacity-70 cursor-wait" : ""}`}
      >
        {t("analyze_btn", lang)}
      </button>
      {needsUsername ? (
        <button
          type="button"
          onClick={() => onOpenSettings?.()}
          className="text-[11px] text-accent hover:text-accent-hover transition-colors underline decoration-dotted underline-offset-2"
        >
          {t("need_username_hint", lang)}
        </button>
      ) : (
        <p className="text-[11px] text-gray-500 leading-snug">{t("analyze_hint", lang)}</p>
      )}

      {/* Étape 2 : supprime UNIQUEMENT les faux flaggés que l'utilisateur a vus et
          validés (sélection cochée si active, U-C2). Masqué pendant la fenêtre
          d'annulation différée (U-H1). */}
      {!isRunning && !pendingDelete && fakesToRemove > 0 && (
        <button
          onClick={requestRemoveFakes}
          disabled={!!loading}
          className={`w-full px-3 py-2 rounded-lg font-medium text-sm transition-all
            bg-red-600/90 text-white hover:bg-red-500 active:scale-95`}
        >
          {(selectionActive ? t("remove_selection_btn", lang) : t("remove_fakes_btn", lang))}{" "}
          ({fakesToRemove.toLocaleString()})
        </button>
      )}

      {/* U-H1 : fenêtre d'annulation avant exécution (le seul « undo » possible). */}
      {pendingDelete && (
        <PendingDeleteBanner
          until={pendingDelete.until}
          count={pendingDelete.count}
          lang={lang}
          onCancel={cancelDeferredDelete}
        />
      )}

      <button
        onClick={() => run("stop")}
        disabled={!!loading || !isRunning}
        className={`w-full px-3 py-2 rounded-lg font-medium text-sm transition-all
          ${isRunning
            ? "bg-red-600 text-white hover:bg-red-500 active:scale-95"
            : "bg-gray-800 text-gray-600 cursor-not-allowed"
          }`}
      >
        {isRunning ? t("stop", lang) : t("stopped", lang)}
      </button>

      {/* Avancé : contrôles manuels d'origine en 2 temps (utilisateurs avertis /
          mode continu payant). Masqués par défaut pour garder le flux débutant clair. */}
      <button
        onClick={() => setShowAdvanced((v) => !v)}
        className="text-[11px] text-gray-500 hover:text-gray-300 transition-colors inline-flex items-center gap-1"
      >
        {showAdvanced ? <IconChevronDown /> : <IconChevronRight />}
        {t("advanced_toggle", lang)}
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
              ${loading === "fetch" ? "opacity-70 cursor-wait" : ""}`}
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
              ${loading === "clean" || loading === "continuous" ? "opacity-70 cursor-wait" : ""}`}
          >
            {t("clean_btn", lang)}
            {licence.active && (
              <span className="ml-1 text-[11px] opacity-70">{t("continuous_label", lang)}</span>
            )}
          </button>
        </div>
      )}

      {/* « Tout rescanner » : passe complète (fetch sans early-stop pour capter
          les nouveaux abonnés + remise à zéro + ré-analyse de tous). Visible dans
          le mode avancé, jamais de suppression auto. */}
      {showAdvanced && (
        <>
          <button
            onClick={() => run("rescanAll")}
            disabled={!!loading || !!isRunning}
            className={`w-full px-3 py-2 rounded-lg font-medium text-sm transition-all
              ${isRunning
                ? "bg-gray-800 text-gray-600 cursor-not-allowed"
                : "bg-gray-700 text-white hover:bg-gray-600 active:scale-95"
              }
              ${loading === "rescanAll" ? "opacity-70 cursor-wait" : ""}`}
          >
            {t("rescan_all_btn", lang)}
          </button>
          <p className="text-[11px] text-gray-500 leading-snug">{t("rescan_all_hint", lang)}</p>
        </>
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
        <p className="text-[11px] text-gray-500 leading-snug">{t("running_background_hint", lang)}</p>
      )}

      {/* Progress bar — U-H4 : compteur X/Y + ETA, pas juste un % */}
      {isRunning && totalFollowers > 0 && (
        <div className="space-y-1">
          <div className="flex justify-between text-[11px] text-gray-500">
            <span>{t("progress_label", lang)}</span>
            <span className="tabular-nums">
              {scanned.toLocaleString()}/{totalFollowers.toLocaleString()} · {progress}%
            </span>
          </div>
          <div className="w-full h-1.5 bg-gray-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-accent rounded-full transition-all duration-700 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>
          {etaMs !== null && etaMs > 0 && (
            <p className="text-[11px] text-gray-500 tabular-nums">
              {t("eta_label", lang).replace("{0}", formatEta(etaMs, lang))}
            </p>
          )}
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
      <p className="text-[11px] text-gray-500 leading-snug">{t("fetch_limit_note", lang)}</p>

      {/* Rendre les limites du plan gratuit visibles d'emblée, pas en mur surprise. */}
      {!licence.active && (
        <div className="space-y-0.5">
          <p className="text-[11px] text-gray-500 leading-snug">{t("free_plan_note", lang)}</p>
          {cyclesToday !== null && (
            <p className="text-[11px] text-gray-400 tabular-nums">
              {t("free_usage_today", lang)
                .replace("{0}", String(cyclesToday))
                .replace("{1}", String(FREE_LIMITS.cyclesPerDay))}
            </p>
          )}
        </div>
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

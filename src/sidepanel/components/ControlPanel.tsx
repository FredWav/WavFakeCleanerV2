import { useState, useEffect, useRef } from "react";
import { api } from "../lib/messaging";
import { t } from "../lib/i18n";
import { FREE_LIMITS, type Stats, type LicenseInfo } from "@shared/types";
import Modal from "./ui/Modal";

// Étape courante du parcours (écran unique guidé). Pilote quels contrôles
// s'affichent — le composant reste MONTÉ en permanence pour préserver son état
// (file de suppression différée, modale de confirmation) entre les étapes.
export type Stage = "start" | "running" | "results";

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
    <div className="text-accent-deep text-xs bg-review-bg border border-accent/25 rounded-lg px-2 py-1.5 leading-snug">
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
    <div className="flex items-center gap-2 rounded-lg border border-suspect/25 bg-suspect-bg px-2 py-1.5">
      <span className="flex-1 text-xs text-suspect leading-snug">
        {t("pending_delete", lang)
          .replace("{0}", count.toLocaleString())
          .replace("{1}", String(secs))}
      </span>
      <button
        onClick={onCancel}
        className="shrink-0 px-2 py-1 rounded-lg text-xs font-bold bg-surface border border-line text-ink hover:bg-surface-2 active:scale-95 transition-all"
      >
        {t("cancel_delete", lang)}
      </button>
    </div>
  );
}

export default function ControlPanel({
  stage,
  stats,
  lang,
  licence,
  onRefresh,
  fakeSelection = null,
  username = "",
  onSaveUsername,
}: {
  // Écran unique guidé : l'étape est dérivée des stats par App.
  stage: Stage;
  stats: Stats | null;
  lang: string;
  licence: LicenseInfo;
  onRefresh: () => void;
  // U-C2 : sélection explicite des faux à supprimer (cases cochées dans la
  // table). null = pas de sélection active → on supprime tous les faux flaggés.
  fakeSelection?: string[] | null;
  // Lot 1/2 : @ requis pour lancer le scan. Saisi inline à l'étape start.
  username?: string;
  onSaveUsername?: (handle: string) => Promise<void> | void;
}) {
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Lot 2 : saisie du @ inline (étape start). Initialisée depuis le pseudo
  // enregistré, resynchronisée s'il change (ex. modifié dans les Réglages).
  const [draft, setDraft] = useState(username);
  useEffect(() => { setDraft(username); }, [username]);
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

  // Lot 2 : saisie inline → on enregistre le @ (s'il a changé) PUIS on lance
  // l'analyse. Le préalable et l'action vivent au même endroit (fini le détour
  // par les Réglages), et le run ne part jamais sur un compte vide.
  async function handleAnalyze() {
    const handle = draft.trim().replace(/\s+/g, "").replace(/^@+/, "");
    if (!handle) return;
    if (handle !== username) {
      try { await onSaveUsername?.(handle); } catch { /* on tente quand même */ }
    }
    run("analyze");
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

  // Mode continu (licenciés) : scan + suppression automatique en boucle. Comme
  // il supprime, il passe aussi par la confirmation obligatoire.
  function handleContinuous() {
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
    <div className="space-y-3">
      {/* ÉTAPE START — connexion du compte + lancement de l'analyse. */}
      {stage === "start" && (
        <>
          {/* Réassurance permanente : les vrais abonnés ne sont jamais touchés. */}
          <p className="text-[11px] text-clean bg-clean-bg border border-clean/15 rounded-lg px-2 py-1.5 leading-snug">
            {t("safety_promise", lang)}
          </p>

          {/* Saisie @ inline : le préalable et l'action au même endroit. */}
          <div>
            <label className="block text-[11px] text-ink-soft mb-1">{t("connect_username_label", lang)}</label>
            <div className="flex items-center gap-1.5 bg-surface border border-line rounded-xl px-3 focus-within:border-accent transition-colors">
              <span className="text-ink-soft text-base select-none">@</span>
              <input
                type="text"
                value={draft}
                placeholder={t("username_placeholder", lang)}
                onChange={(e) => setDraft(e.target.value.replace(/\s+/g, "").replace(/^@+/, ""))}
                onKeyDown={(e) => { if (e.key === "Enter") handleAnalyze(); }}
                className="flex-1 bg-transparent py-2.5 text-base text-ink placeholder-ink-faint outline-none"
              />
            </div>
          </div>

          <button
            onClick={handleAnalyze}
            disabled={!!loading || !draft.trim()}
            className={`w-full px-3 py-3 rounded-xl font-bold text-base transition-all
              ${!draft.trim()
                ? "bg-surface-2 border border-line text-ink-faint cursor-not-allowed"
                : "bg-accent text-accent-ink hover:bg-accent-hover active:scale-95"
              }
              ${loading === "analyze" ? "opacity-70 cursor-wait" : ""}`}
          >
            {t("analyze_btn", lang)}
          </button>
          <p className="text-[11px] text-ink-soft leading-snug">{t("analyze_hint", lang)}</p>
          <p className="text-[11px] text-ink-faint leading-snug">{t("fetch_limit_note", lang)}</p>
        </>
      )}

      {/* ÉTAPE RUNNING — progression du scan (aucune suppression ici). */}
      {stage === "running" && (
        <>
          <button
            onClick={() => run("stop")}
            disabled={!!loading}
            className="w-full px-3 py-2.5 rounded-xl font-medium text-sm transition-all
              bg-suspect text-white hover:bg-suspect/90 active:scale-95"
          >
            {t("stop", lang)}
          </button>

          {/* Anti-block pause countdown (explains why the bar is frozen) */}
          {stats?.pausedUntil ? (
            <PauseBanner
              until={stats.pausedUntil}
              reason={stats.pauseReason ?? null}
              lang={lang}
              removed={stats.removed ?? 0}
            />
          ) : null}

          {/* Dire à l'utilisateur qu'il peut partir — le scan continue en fond. */}
          <p className="text-[11px] text-ink-soft leading-snug">{t("running_background_hint", lang)}</p>

          {/* Progress bar — U-H4 : compteur X/Y + ETA, pas juste un % */}
          {totalFollowers > 0 && (
            <div className="space-y-1">
              <div className="flex justify-between text-[11px] text-ink-soft">
                <span>{t("progress_label", lang)}</span>
                <span className="tabular-nums">
                  {scanned.toLocaleString()}/{totalFollowers.toLocaleString()} · {progress}%
                </span>
              </div>
              <div className="w-full h-1.5 bg-line rounded-full overflow-hidden">
                <div
                  className="h-full bg-accent rounded-full transition-all duration-700 ease-out"
                  style={{ width: `${progress}%` }}
                />
              </div>
              {etaMs !== null && etaMs > 0 && (
                <p className="text-[11px] text-ink-soft tabular-nums">
                  {t("eta_label", lang).replace("{0}", formatEta(etaMs, lang))}
                </p>
              )}
            </div>
          )}
        </>
      )}

      {/* ÉTAPE RESULTS — supprimer les faux vus / relancer / nettoyage auto. */}
      {stage === "results" && (
        <>
          {/* Réassurance juste avant l'action de suppression. */}
          <p className="text-[11px] text-clean bg-clean-bg border border-clean/15 rounded-lg px-2 py-1.5 leading-snug">
            {t("safety_promise", lang)}
          </p>

          {/* Suppression des faux flaggés que l'utilisateur a vus et validés
              (sélection cochée si active, U-C2). Masquée pendant la fenêtre
              d'annulation différée (U-H1). */}
          {!pendingDelete && fakesToRemove > 0 && (
            <button
              onClick={requestRemoveFakes}
              disabled={!!loading}
              className="w-full px-3 py-2.5 rounded-xl font-medium text-sm transition-all
                bg-suspect text-white hover:bg-suspect/90 active:scale-95"
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

          {/* Relancer une analyse (incrémentale, capte les nouveaux abonnés).
              Verrouillé pendant la fenêtre d'annulation pour ne pas démarrer un
              scan alors qu'une suppression est en attente d'exécution. */}
          <button
            onClick={() => run("analyze")}
            disabled={!!loading || !!pendingDelete}
            className="w-full px-3 py-2.5 rounded-xl font-medium text-sm transition-all
              bg-surface-2 border border-line text-ink hover:bg-surface active:scale-95
              disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {t("relaunch_btn", lang)}
          </button>
          <button
            type="button"
            onClick={() => run("rescanAll")}
            disabled={!!loading || !!pendingDelete}
            className="text-[11px] text-ink-soft hover:text-ink-soft transition-colors underline decoration-dotted underline-offset-2 disabled:opacity-50"
          >
            {t("rescan_all_btn", lang)}
          </button>

          {/* Mode continu (licenciés) : sorti du repli « avancé » et clairement
              décrit AVANT activation (l'audit : nature jamais posée avant le clic). */}
          {licence.active && (
            <div className="rounded-xl border border-line bg-surface-2 px-3 py-2.5 space-y-1">
              <p className="text-xs text-ink font-medium">{t("auto_clean_title", lang)}</p>
              <p className="text-[11px] text-ink-soft leading-snug">{t("auto_clean_desc", lang)}</p>
              <button
                type="button"
                onClick={handleContinuous}
                disabled={!!loading || !!pendingDelete}
                className="text-[11px] text-accent-deep hover:text-accent transition-colors underline decoration-dotted underline-offset-2 disabled:opacity-50"
              >
                {t("auto_clean_cta", lang)}
              </button>
            </div>
          )}

          {/* Limites du plan gratuit, visibles sans mur surprise. */}
          {!licence.active && (
            <div className="space-y-0.5">
              <p className="text-[11px] text-ink-soft leading-snug">{t("free_plan_note", lang)}</p>
              {cyclesToday !== null && (
                <p className="text-[11px] text-ink-soft tabular-nums">
                  {t("free_usage_today", lang)
                    .replace("{0}", String(cyclesToday))
                    .replace("{1}", String(FREE_LIMITS.cyclesPerDay))}
                </p>
              )}
            </div>
          )}
        </>
      )}

      {/* TRANSVERSAL — erreurs (toujours affichées si présentes). */}
      {error && (
        <div className="text-suspect text-xs bg-suspect-bg rounded-lg px-2 py-1">{error}</div>
      )}
      {!error && !isRunning && stats?.lastError && (
        <div className="text-suspect text-xs bg-suspect-bg rounded-lg px-2 py-1.5 leading-snug">
          {stats.lastError}
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
            <h3 className="text-sm font-bold text-ink">{title}</h3>
            <p className="text-xs text-ink-soft leading-snug">{body}</p>
            {confirm.sample.length > 0 && (
              <p className="text-[11px] text-ink-soft leading-snug break-words">
                {t("confirm_remove_sample", lang).replace(
                  "{0}",
                  confirm.sample.map((u) => "@" + u).join(", "),
                )}
                {confirm.count > confirm.sample.length ? " …" : ""}
              </p>
            )}
            {ackRequired && (
              <label className="flex items-start gap-2 text-xs text-ink cursor-pointer">
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={(e) => setAck(e.target.checked)}
                  className="mt-0.5 accent-suspect"
                />
                <span>{t("confirm_remove_ack", lang)}</span>
              </label>
            )}
            <div className="flex gap-2 pt-1">
              <button
                onClick={close}
                className="flex-1 px-3 py-2 rounded-lg text-sm font-medium bg-surface-2 border border-line text-ink hover:bg-surface active:scale-95 transition-all"
              >
                {t("confirm_cancel", lang)}
              </button>
              <button
                onClick={confirmProceed}
                disabled={ackRequired && !ack}
                className={`flex-1 px-3 py-2 rounded-lg text-sm font-bold transition-all
                  ${ackRequired && !ack
                    ? "bg-surface-2 border border-line text-ink-faint cursor-not-allowed"
                    : "bg-suspect text-white hover:bg-suspect/90 active:scale-95"}`}
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

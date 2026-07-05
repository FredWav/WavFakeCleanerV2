import { useState, useEffect, useCallback, useRef } from "react";
import { useStats } from "./hooks/useStats";
import { useLog } from "./hooks/useLog";
import { t, getStoredLang, setStoredLang } from "./lib/i18n";
import { api } from "./lib/messaging";
import StatCards from "./components/StatCards";
import ControlPanel, { type Stage } from "./components/ControlPanel";
import CommunityCard from "./components/CommunityCard";
import LogConsole from "./components/LogConsole";
import FollowerTable from "./components/FollowerTable";
import SettingsPanel from "./components/SettingsPanel";
import Toast from "./components/Toast";
import Onboarding from "./components/Onboarding";
import { IconX } from "./components/Icons";
import { COMMUNITY_STATS_URL } from "@shared/constants";
import type { LicenseInfo } from "@shared/types";

// Logo de marque (icône Chrome existante) — affiché dans l'en-tête (D2 :
// l'identité dormait dans le dossier /design et n'apparaissait jamais dans l'UI).
const LOGO_URL = chrome.runtime?.getURL?.("icons/icon128.png") ?? "icons/icon128.png";

export default function App() {
  const [lang, setLang] = useState(getStoredLang);
  const [showSettings, setShowSettings] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  // Plus de licence : accès complet pour tous. On garde l'objet pour les
  // composants qui le lisent, mais il est toujours actif.
  const [licence, setLicence] = useState<LicenseInfo>({ active: true, key: "free", activatedAt: 0, communityToken: null });
  // U-L2 : file de toasts empilables (avant : un seul toast, le suivant écrasait
  // le précédent). Cap à 4 affichés ; chaque toast s'auto-efface.
  const toastId = useRef(0);
  const [toasts, setToasts] = useState<{ id: number; msg: string }[]>([]);
  const pushToast = useCallback((msg: string) => {
    const id = ++toastId.current;
    setToasts((q) => [...q, { id, msg }].slice(-4));
  }, []);
  const dismissToast = useCallback((id: number) => {
    setToasts((q) => q.filter((to) => to.id !== id));
  }, []);
  const [communityTotal, setCommunityTotal] = useState<number | null>(null);
  // U-C2 : sélection des faux à supprimer, partagée entre la table (cases à
  // cocher) et le ControlPanel (bouton Supprimer). null = pas de sélection active.
  const [fakeSelection, setFakeSelection] = useState<string[] | null>(null);
  const [showTelemetryNotice, setShowTelemetryNotice] = useState(false);
  // Lot 1 : le @ est le préalable obligatoire du scan. On le tient en état pour
  // (a) bloquer « Analyser » tant qu'il est vide et (b) le recharger dès que les
  // réglages se ferment.
  const [username, setUsername] = useState<string>("");
  // Lot 1 : signal incrémenté pour forcer la table sur le filtre « Faux » quand
  // l'analyse se termine (traçage du chemin — cf. effet plus bas).
  const [fakeFilterSignal, setFakeFilterSignal] = useState(0);
  const prevRunning = useRef(false);
  const { stats, refresh } = useStats(3000);
  const { logs, connected, clearLogs } = useLog(300);

  const reloadUsername = useCallback(() => {
    api.getSettings().then((s) => setUsername(s.threadsUsername || "")).catch(() => {});
  }, []);

  // Lot 2 : enregistre le @ saisi inline (étape start) puis met l'état à jour —
  // le préalable et l'action (Analyser) vivent au même endroit.
  const saveUsername = useCallback(async (handle: string) => {
    const h = handle.trim().replace(/\s+/g, "").replace(/^@+/, "");
    const s = await api.getSettings();
    await api.updateSettings({ ...s, threadsUsername: h });
    setUsername(h);
  }, []);

  // Lot 1/2 — traçage du chemin : dès que l'analyse se termine avec des faux, on
  // force la table sur le filtre « Faux » pour montrer directement ce qui peut
  // être supprimé (l'écran bascule seul en étape « résultats »).
  useEffect(() => {
    const running = !!stats?.isRunning;
    if (prevRunning.current && !running && (stats?.fakes ?? 0) > 0) {
      setFakeFilterSignal((n) => n + 1);
    }
    prevRunning.current = running;
  }, [stats?.isRunning, stats?.fakes]);

  // One-time notice after the v3 update: telemetry is now on by default.
  // The flag is set by the onInstalled migration and cleared on dismiss.
  useEffect(() => {
    chrome.storage.local.get("wfc_telemetry_notice_pending").then((r) => {
      if (r?.wfc_telemetry_notice_pending) setShowTelemetryNotice(true);
    }).catch(() => {});
  }, []);

  function dismissTelemetryNotice() {
    setShowTelemetryNotice(false);
    chrome.storage.local.remove("wfc_telemetry_notice_pending").catch(() => {});
  }

  // Total communautaire de faux, récupéré une fois et partagé avec la bannière de
  // stats et la fenêtre Licence (preuve sociale). Échoue en silence — purement décoratif.
  useEffect(() => {
    fetch(COMMUNITY_STATS_URL)
      .then((r) => r.json())
      .then((d: { totalFakesDetected?: number }) => {
        if (typeof d.totalFakesDetected === "number" && d.totalFakesDetected > 0) {
          setCommunityTotal(d.totalFakesDetected);
        }
      })
      .catch(() => {});
  }, []);

  // Initial load: settings (for onboarding gate) and licence state.
  // Split into separate effects so each has a single, obvious responsibility
  // and can re-run independently if its dependency changes.
  useEffect(() => {
    let cancelled = false;
    api.getSettings().then((s) => {
      if (cancelled) return;
      setUsername(s.threadsUsername || "");
      if (!s.threadsUsername && !localStorage.getItem("wav_onboarding_done")) {
        setShowOnboarding(true);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.getLicense().then((lic) => {
      if (cancelled) return;
      setLicence(lic);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Surface a one-time toast when a selector drift is detected on Threads.
  // The content script reports drift as LOG_FROM_CONTENT with category="drift";
  // service-worker rebroadcasts as LOG_EVENT. Capping to once per session
  // prevents toast spam if multiple lookups fall back simultaneously.
  useEffect(() => {
    let shown = false;
    const listener = (message: { type?: string; payload?: { category?: string } }) => {
      if (shown) return;
      if (message.type !== "LOG_EVENT") return;
      if (message.payload?.category !== "drift") return;
      shown = true;
      pushToast(t("drift_detected", lang));
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [lang]);

  function toggleLang() {
    const cycle: Record<string, string> = { fr: "en", en: "es", es: "fr" };
    const next = cycle[lang] || "fr";
    setLang(next);
    setStoredLang(next);
  }

  // Lot 2 — écran unique guidé : l'étape du parcours est dérivée des stats.
  // start = rien encore (connexion + analyse) ; running = scan en cours ;
  // results = données présentes (bilan + table). Plus d'onglets.
  const running = !!stats?.isRunning;
  const hasData =
    (stats?.totalFollowers ?? 0) > 0 || (stats?.scanned ?? 0) > 0 || (stats?.removed ?? 0) > 0;
  const stage: Stage = running ? "running" : hasData ? "results" : "start";
  const fakes = stats?.fakes ?? 0;

  return (
    <div className="w-full px-4 py-5 space-y-5">
      {/* Header */}
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <img src={LOGO_URL} alt="Wav Fake Cleaner" className="w-7 h-7 rounded-md shrink-0" />
          <div>
            <h1 className="text-xl font-bold text-ink leading-none tracking-tight">Wav Fake Cleaner</h1>
            <p className="text-[11px] text-ink-faint">
              by{" "}
              <a
                href="https://fredwav.com/contact"
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:text-accent-hover transition-colors"
              >
                Fred Wav
              </a>
            </p>
          </div>
        </div>
        <div className="flex gap-1.5 items-center">
          <button
            onClick={() => setShowSettings(true)}
            className="px-2 py-1 rounded-lg bg-surface border border-line text-[11px] text-ink-soft
              hover:text-ink hover:border-ink-faint transition-colors"
          >
            {t("settings", lang)}
          </button>
          <button
            onClick={toggleLang}
            className="px-2 py-1 rounded-lg bg-surface border border-line text-[11px] text-ink-soft
              hover:text-ink hover:border-ink-faint transition-colors"
          >
            {t("lang_toggle", lang)}
          </button>
        </div>
      </header>

      {/* One-time v3 telemetry notice */}
      {showTelemetryNotice && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-xl border border-line bg-surface text-[11px] text-ink-soft">
          <span className="flex-1 leading-snug">{t("telemetry_notice", lang)}</span>
          <button
            onClick={() => { dismissTelemetryNotice(); setShowSettings(true); }}
            className="shrink-0 px-2 py-0.5 rounded bg-accent text-accent-ink font-medium hover:bg-accent-hover transition-colors"
          >
            {t("telemetry_notice_cta", lang)}
          </button>
          <button
            onClick={dismissTelemetryNotice}
            className="shrink-0 text-ink-faint hover:text-ink transition-colors p-0.5"
            aria-label={t("confirm_cancel", lang)}
          >
            <IconX />
          </button>
        </div>
      )}

      {/* Dashboard de stats : masqué à l'étape start (rien à montrer). */}
      {stage !== "start" && (
        <StatCards stats={stats} lang={lang} communityTotal={communityTotal} />
      )}

      {/* Accroche à l'étape start (eyebrow éditorial + titre). */}
      {stage === "start" && (
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-faint">{t("audience_eyebrow", lang)}</div>
          <h2 className="text-2xl font-bold text-ink leading-tight tracking-tight mt-1.5">{t("connect_title", lang)}</h2>
        </div>
      )}

      {/* Bilan héros à l'étape résultats : le chiffre qui compte, en grand,
          composé en figure éditoriale (nombre + libellé aligné sur la base). */}
      {stage === "results" && (
        fakes > 0 ? (
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-faint">{t("audience_eyebrow", lang)}</div>
            <div className="flex items-baseline gap-3 mt-1.5">
              <span className="text-6xl font-extrabold text-ink tabular-nums leading-[0.9] tracking-tight">
                {fakes.toLocaleString()}
              </span>
              <div className="min-w-0">
                <div className="text-base font-semibold text-ink leading-tight">{t("hero_fakes_label", lang)}</div>
                <div className="text-xs text-ink-soft mt-0.5">
                  {t("hero_context", lang).replace("{0}", (stats?.totalFollowers ?? 0).toLocaleString())}
                </div>
              </div>
            </div>
          </div>
        ) : (stats?.scanned ?? 0) > 0 ? (
          <div className="text-center py-2">
            <div className="text-4xl text-clean" aria-hidden="true">✓</div>
            <div className="text-lg text-ink font-bold mt-1">{t("hero_clean_title", lang)}</div>
            <div className="text-xs text-ink-faint mt-0.5">{t("hero_clean_sub", lang)}</div>
          </div>
        ) : null
      )}

      {/* Contrôles guidés. ControlPanel reste MONTÉ à toutes les étapes pour
          préserver son état (file de suppression différée, modale de confirmation). */}
      <ControlPanel
        stage={stage}
        stats={stats}
        lang={lang}
        licence={licence}
        onRefresh={refresh}
        fakeSelection={fakeSelection}
        username={username}
        onSaveUsername={saveUsername}
      />

      {/* Résultats : la table des abonnés / faux / à vérifier. */}
      {stage === "results" && (
        <FollowerTable
          lang={lang}
          showToast={pushToast}
          refreshTrigger={(stats?.totalFollowers ?? 0) + (stats?.scanned ?? 0) + (stats?.removed ?? 0)}
          onFakeSelectionChange={setFakeSelection}
          fakeFilterSignal={fakeFilterSignal}
        />
      )}

      {/* Communauté — repliée, accessible en permanence (plus un onglet de 1er rang). */}
      <details className="group">
        <summary className="cursor-pointer select-none text-[11px] text-ink-faint hover:text-ink transition-colors">
          {t("tab_community", lang)}
        </summary>
        <div className="mt-2">
          <CommunityCard
            lang={lang}
            licence={licence}
            showToast={pushToast}
          />
        </div>
      </details>

      {/* Journal d'activité — replié par défaut, en bas (U-M4 : plus au milieu) */}
      <details className="group">
        <summary className="cursor-pointer select-none text-[11px] text-ink-faint hover:text-ink transition-colors">
          {t("activity_toggle", lang)}
        </summary>
        <div className="mt-1">
          <LogConsole logs={logs} connected={connected} onClear={clearLogs} lang={lang} />
        </div>
      </details>

      {/* Settings modal */}
      {showSettings && (
        <SettingsPanel
          lang={lang}
          onClose={() => { setShowSettings(false); reloadUsername(); }}
          showToast={pushToast}
        />
      )}

      {/* Onboarding */}
      {showOnboarding && (
        <Onboarding
          lang={lang}
          onDismiss={() => setShowOnboarding(false)}
          onOpenSettings={() => { setShowOnboarding(false); setShowSettings(true); }}
        />
      )}

      {/* Toasts empilés (U-L2) */}
      <div className="fixed bottom-3 left-3 right-3 z-50 flex flex-col items-center gap-1.5 pointer-events-none">
        {toasts.map((to) => (
          <Toast key={to.id} message={to.msg} onDismiss={() => dismissToast(to.id)} />
        ))}
      </div>
    </div>
  );
}

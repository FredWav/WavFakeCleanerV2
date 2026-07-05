import { useState, useEffect } from "react";
import { api } from "../lib/messaging";
import { t } from "../lib/i18n";
import type { Settings } from "@shared/types";
import Modal from "./ui/Modal";
import Button from "./ui/Button";
import { IconX } from "./Icons";

export default function SettingsPanel({
  lang,
  onClose,
  showToast,
}: {
  lang: string;
  onClose: () => void;
  showToast?: (msg: string) => void;
}) {
  const [form, setForm] = useState<Settings>({
    threadsUsername: "",
    scoreThreshold: 70,
    privateAlwaysReview: false,
    telemetry: true, // v3 default — the stored value overwrites this on load
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getSettings().then((s) => setForm(s)).catch(() => {});
  }, []);

  async function save() {
    // Lot 1 : le @ est le préalable du scan — on valide et on donne un retour
    // clair plutôt que de laisser partir un run sur un compte vide/inexistant.
    const handle = form.threadsUsername.trim();
    if (!handle) {
      setError(t("username_required", lang));
      return;
    }
    if (!/^[a-zA-Z0-9._]{1,30}$/.test(handle)) {
      setError(t("username_invalid", lang));
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await api.updateSettings({ ...form, threadsUsername: handle });
      setSaved(true);
      showToast?.(t("toast_settings_saved", lang));
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      // U-H7 : message humain traduit pour l'utilisateur, détail technique en console.
      console.error("[WFC] settings save failed:", e);
      setError(t("settings_save_failed", lang));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose}>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-ink">{t("settings", lang)}</h2>
          <button onClick={onClose} aria-label={t("confirm_cancel", lang)} className="text-ink-faint hover:text-ink p-1">
            <IconX />
          </button>
        </div>

        <div className="divide-y divide-line text-xs">
          {/* Username */}
          <div className="flex items-center justify-between gap-3 py-2">
            <label className="text-ink-soft">{t("username", lang)}</label>
            <input
              type="text"
              value={form.threadsUsername}
              placeholder={t("username_placeholder", lang)}
              // U-M2 : normalise à la saisie — retire le @ initial et les espaces
              // (l'utilisateur colle souvent « @fredwav »).
              onChange={(e) =>
                setForm({ ...form, threadsUsername: e.target.value.replace(/\s+/g, "").replace(/^@+/, "") })
              }
              className="bg-surface border border-line rounded-lg px-2 py-1
                text-xs text-ink w-36 placeholder-ink-faint focus:border-accent outline-none"
            />
          </div>
          {/* Threshold */}
          <div className="flex items-center justify-between gap-3 py-2">
            <label className="text-ink-soft">{t("threshold", lang)}</label>
            <input
              type="number"
              value={form.scoreThreshold}
              onChange={(e) =>
                setForm({ ...form, scoreThreshold: parseInt(e.target.value) || 70 })
              }
              className="bg-surface border border-line rounded-lg px-2 py-1
                text-xs text-ink w-20 focus:border-accent outline-none"
            />
          </div>
          {/* Private = review */}
          <div className="flex items-center justify-between gap-3 py-2">
            <label className="text-ink-soft">{t("setting_private_review", lang)}</label>
            <button
              onClick={() => setForm({ ...form, privateAlwaysReview: !form.privateAlwaysReview })}
              role="switch"
              aria-checked={!!form.privateAlwaysReview}
              aria-label={t("setting_private_review", lang)}
              className={`w-9 h-5 rounded-full transition-colors relative flex-shrink-0 ${form.privateAlwaysReview ? "bg-accent" : "bg-line"}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${form.privateAlwaysReview ? "translate-x-4" : "translate-x-0"}`} />
            </button>
          </div>
          {/* Telemetry opt-in */}
          <div className="flex items-start justify-between gap-3 py-2">
            <div className="flex-1">
              <label className="text-ink-soft block">{t("setting_telemetry", lang)}</label>
              <p className="text-[11px] text-ink-faint mt-0.5">{t("setting_telemetry_hint", lang)}</p>
            </div>
            <button
              onClick={() => setForm({ ...form, telemetry: !form.telemetry })}
              role="switch"
              aria-checked={!!form.telemetry}
              aria-label={t("setting_telemetry", lang)}
              className={`w-9 h-5 rounded-full transition-colors relative flex-shrink-0 mt-0.5 ${form.telemetry ? "bg-accent" : "bg-line"}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${form.telemetry ? "translate-x-4" : "translate-x-0"}`} />
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2 pt-1">
          <Button onClick={save} disabled={saving}>
            {saving ? "..." : t("save", lang)}
          </Button>
          {saved && <span className="text-clean text-xs">{t("saved", lang)}</span>}
          {error && <span className="text-suspect text-xs">{error}</span>}
        </div>
    </Modal>
  );
}

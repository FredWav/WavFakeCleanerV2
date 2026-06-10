import { useState, useEffect } from "react";
import { api } from "../lib/messaging";
import { t } from "../lib/i18n";
import type { Settings } from "@shared/types";

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
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await api.updateSettings(form);
      setSaved(true);
      showToast?.(t("toast_settings_saved", lang));
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-2"
      onClick={onClose}
    >
      <div
        className="bg-gray-900 rounded-2xl border border-gray-800 w-full max-w-sm p-4 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-white">{t("settings", lang)}</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-lg">
            ×
          </button>
        </div>

        <div className="divide-y divide-gray-800 text-xs">
          {/* Username */}
          <div className="flex items-center justify-between gap-3 py-2">
            <label className="text-gray-400">{t("username", lang)}</label>
            <input
              type="text"
              value={form.threadsUsername}
              onChange={(e) => setForm({ ...form, threadsUsername: e.target.value })}
              className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1
                text-xs text-white w-36 focus:border-purple-500 outline-none"
            />
          </div>
          {/* Threshold */}
          <div className="flex items-center justify-between gap-3 py-2">
            <label className="text-gray-400">{t("threshold", lang)}</label>
            <input
              type="number"
              value={form.scoreThreshold}
              onChange={(e) =>
                setForm({ ...form, scoreThreshold: parseInt(e.target.value) || 70 })
              }
              className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1
                text-xs text-white w-20 focus:border-purple-500 outline-none"
            />
          </div>
          {/* Private = review */}
          <div className="flex items-center justify-between gap-3 py-2">
            <label className="text-gray-400">{t("setting_private_review", lang)}</label>
            <button
              onClick={() => setForm({ ...form, privateAlwaysReview: !form.privateAlwaysReview })}
              className={`w-9 h-5 rounded-full transition-colors relative flex-shrink-0 ${form.privateAlwaysReview ? "bg-purple-600" : "bg-gray-700"}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${form.privateAlwaysReview ? "translate-x-4" : "translate-x-0"}`} />
            </button>
          </div>
          {/* Telemetry opt-in */}
          <div className="flex items-start justify-between gap-3 py-2">
            <div className="flex-1">
              <label className="text-gray-400 block">{t("setting_telemetry", lang)}</label>
              <p className="text-[10px] text-gray-600 mt-0.5">{t("setting_telemetry_hint", lang)}</p>
            </div>
            <button
              onClick={() => setForm({ ...form, telemetry: !form.telemetry })}
              className={`w-9 h-5 rounded-full transition-colors relative flex-shrink-0 mt-0.5 ${form.telemetry ? "bg-purple-600" : "bg-gray-700"}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${form.telemetry ? "translate-x-4" : "translate-x-0"}`} />
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={save}
            disabled={saving}
            className="bg-purple-600 text-white px-3 py-1.5 rounded-lg text-xs font-medium
              hover:bg-purple-500 transition-colors disabled:opacity-50"
          >
            {saving ? "..." : t("save", lang)}
          </button>
          {saved && <span className="text-green-400 text-xs">{t("saved", lang)}</span>}
          {error && <span className="text-red-400 text-xs">{error}</span>}
        </div>
      </div>
    </div>
  );
}

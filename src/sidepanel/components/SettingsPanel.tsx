import { useState, useEffect } from "react";
import { api } from "../lib/messaging";
import { t } from "../lib/i18n";
import { SAFETY_PROFILES } from "@shared/constants";
import type { Settings, SafetyProfile } from "@shared/types";

const PROFILE_ORDER: SafetyProfile[] = ["gratuit", "prudent", "normal", "agressif"];

export default function SettingsPanel({
  lang,
  hasLicence,
  onClose,
}: {
  lang: string;
  hasLicence: boolean;
  onClose: () => void;
}) {
  const [form, setForm] = useState<Settings>({
    threadsUsername: "",
    scoreThreshold: 70,
    safetyProfile: "gratuit",
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getSettings().then((s) => setForm(s)).catch(() => {});
  }, []);

  async function save() {
    // Enforce gratuit for free users
    const toSave = { ...form };
    if (!hasLicence && toSave.safetyProfile !== "gratuit") {
      toSave.safetyProfile = "gratuit";
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await api.updateSettings(toSave);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  function selectProfile(profile: SafetyProfile) {
    if (profile !== "gratuit" && !hasLicence) return;
    setForm({ ...form, safetyProfile: profile });
  }

  const profileLabels: Record<SafetyProfile, string> = {
    gratuit: t("free", lang),
    prudent: t("prudent", lang),
    normal: t("normal", lang),
    agressif: t("aggressive", lang),
  };

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
            x
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
          {/* Safety Profile */}
          <div className="py-3 space-y-2">
            <label className="text-gray-400 text-xs">{t("safety", lang)}</label>
            <div className="grid grid-cols-2 gap-1.5">
              {PROFILE_ORDER.map((profile) => {
                const config = SAFETY_PROFILES[profile];
                const isSelected = form.safetyProfile === profile;
                const isLocked = profile !== "gratuit" && !hasLicence;

                return (
                  <button
                    key={profile}
                    onClick={() => selectProfile(profile)}
                    disabled={isLocked}
                    className={`relative p-2 rounded-lg border text-left transition-all
                      ${isSelected
                        ? "border-purple-500 bg-purple-600/10"
                        : isLocked
                          ? "border-gray-800 bg-gray-800/30 opacity-50 cursor-not-allowed"
                          : "border-gray-700 bg-gray-800/50 hover:border-gray-600"
                      }`}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className={`text-[11px] font-medium ${isSelected ? "text-purple-300" : isLocked ? "text-gray-600" : "text-gray-300"}`}>
                        {profileLabels[profile]}
                      </span>
                      {isLocked && (
                        <span className="text-[8px] text-gray-600 bg-gray-700/50 px-1 py-0.5 rounded">
                          {t("pro_only", lang)}
                        </span>
                      )}
                    </div>
                    <div className={`text-[9px] mt-0.5 ${isLocked ? "text-gray-700" : "text-gray-500"}`}>
                      {config.limitDay}/{lang === "fr" ? "j" : "d"} · {config.limitHour}/h
                    </div>
                  </button>
                );
              })}
            </div>
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

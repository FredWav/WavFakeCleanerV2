import { useState, useEffect } from "react"
import { api } from "../lib/api"
import { t } from "../lib/i18n"

export default function SettingsPanel({ lang, onClose }) {
  const [form, setForm] = useState({
    threads_username: "",
    score_threshold: 70,
    safety_profile: "normal",
    headless: true,
  })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    api.getSettings().then((s) => {
      setForm({
        threads_username: s.threads_username || "",
        score_threshold: s.score_threshold || 70,
        safety_profile: s.safety_profile || "normal",
        headless: s.headless ?? true,
      })
    }).catch(() => {})
  }, [])

  async function save() {
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      await api.updateSettings(form)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const field = (label, key, type = "text", options = null) => (
    <div className="flex items-center justify-between gap-4 py-2">
      <label className="text-sm text-gray-400 whitespace-nowrap">{label}</label>
      {options ? (
        <select
          value={form[key]}
          onChange={(e) => setForm({ ...form, [key]: e.target.value })}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5
            text-sm text-white focus:border-purple-500 outline-none"
        >
          {options.map(([val, label]) => (
            <option key={val} value={val}>{label}</option>
          ))}
        </select>
      ) : type === "checkbox" ? (
        <input
          type="checkbox"
          checked={form[key]}
          onChange={(e) => setForm({ ...form, [key]: e.target.checked })}
          className="w-4 h-4 accent-purple-500"
        />
      ) : (
        <input
          type={type}
          value={form[key]}
          onChange={(e) => setForm({
            ...form,
            [key]: type === "number" ? parseInt(e.target.value) || 0 : e.target.value,
          })}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5
            text-sm text-white w-48 focus:border-purple-500 outline-none"
        />
      )}
    </div>
  )

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
      onClick={onClose}>
      <div
        className="bg-gray-900 rounded-2xl border border-gray-800 w-full max-w-md p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-white">{t("settings", lang)}</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl">x</button>
        </div>

        <div className="divide-y divide-gray-800">
          {field(t("username", lang), "threads_username")}
          {field(t("threshold", lang), "score_threshold", "number")}
          {field(t("safety", lang), "safety_profile", "text", [
            ["prudent", t("prudent", lang)],
            ["normal", t("normal", lang)],
            ["agressif", t("aggressive", lang)],
          ])}
          {field(t("headless", lang), "headless", "checkbox")}
        </div>

        <div className="flex items-center gap-3 pt-2">
          <button
            onClick={save}
            disabled={saving}
            className="bg-purple-600 text-white px-4 py-2 rounded-lg text-sm font-medium
              hover:bg-purple-500 transition-colors disabled:opacity-50"
          >
            {saving ? "..." : "OK"}
          </button>
          {saved && <span className="text-green-400 text-sm">Saved</span>}
          {error && <span className="text-red-400 text-sm">{error}</span>}
        </div>

        {/* Help text for noobs */}
        <div className="text-xs text-gray-600 space-y-1 pt-2 border-t border-gray-800">
          <p><strong>{t("username", lang)}</strong> : {lang === "fr"
            ? "ton @ Threads (sans le @)"
            : "your Threads @ (without the @)"}</p>
          <p><strong>{t("threshold", lang)}</strong> : {lang === "fr"
            ? "un compte avec un score >= ce seuil sera considere fake (defaut: 70)"
            : "accounts scoring >= this are flagged fake (default: 70)"}</p>
          <p><strong>{t("safety", lang)}</strong> : {lang === "fr"
            ? "prudent = lent mais safe / normal = equilibre / agressif = rapide mais risque"
            : "prudent = slow but safe / normal = balanced / aggressive = fast but risky"}</p>
        </div>
      </div>
    </div>
  )
}

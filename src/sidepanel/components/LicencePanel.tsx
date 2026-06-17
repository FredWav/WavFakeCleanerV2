import { useState, useRef } from "react";
import { api } from "../lib/messaging";
import { t } from "../lib/i18n";
import { PAYMENT_LINK } from "@shared/constants";
import type { LicenseInfo } from "@shared/types";
import { IconCheck, IconX } from "./Icons";
import Modal from "./ui/Modal";

export default function LicencePanel({
  lang,
  licence,
  onUpdate,
  onClose,
  showToast,
  communityTotal,
}: {
  lang: string;
  licence: LicenseInfo;
  onUpdate: (l: LicenseInfo) => void;
  onClose: () => void;
  showToast?: (msg: string) => void;
  communityTotal?: number | null;
}) {
  const [key, setKey] = useState("");
  const [recoverEmail, setRecoverEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [recoverError, setRecoverError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [recoverLoading, setRecoverLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Pull the backup payload and trigger a file download. Returns false if
  // there's nothing to back up (no active licence). Shared by the manual
  // "export" button and the automatic backup after a successful activation.
  async function downloadBackupFile(): Promise<boolean> {
    const result = await api.exportLicense();
    if (!result.ok || !result.backup) return false;
    const blob = new Blob([JSON.stringify(result.backup, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const ts = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `wfc-license-${ts}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return true;
  }

  // After any successful activation/recovery, auto-download a backup so the
  // user keeps a recoverable copy even if they never click "export" — losing
  // it was the #1 cause of lost licences on reinstall. Falls back to the plain
  // success toast if the download couldn't be produced.
  async function onActivated() {
    const updated = await api.getLicense();
    onUpdate(updated);
    let backedUp = false;
    try {
      backedUp = await downloadBackupFile();
    } catch {
      // non-fatal — the licence is active regardless
    }
    showToast?.(t(backedUp ? "licence_success_backed_up" : "licence_success", lang));
  }

  async function activate() {
    if (!key.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.activateLicense(key.trim());
      if (result.ok) {
        await onActivated();
      } else {
        const errKey = result.error === "network_error" ? "licence_network_error" : "licence_invalid";
        setError(t(errKey, lang));
      }
    } catch {
      setError(t("licence_network_error", lang));
    } finally {
      setLoading(false);
    }
  }

  // Recover-by-email: ask the Worker for the code tied to this purchase email,
  // then activate it. Saves users who lost their local storage and never kept
  // their code or a backup file.
  async function recover() {
    if (!recoverEmail.trim()) return;
    setRecoverLoading(true);
    setRecoverError(null);
    try {
      const result = await api.recoverLicense(recoverEmail.trim());
      if (result.ok) {
        await onActivated();
      } else {
        // not_found / network_error / invalid_email come straight from the
        // recover step. Any other code (e.g. licence_invalid forwarded from
        // the post-recover activation, like a since-revoked code) means the
        // email WAS found — so don't blame the email; show a neutral message.
        const errKey =
          result.error === "not_found" ? "licence_recover_not_found" :
          result.error === "network_error" ? "licence_network_error" :
          result.error === "invalid_email" ? "licence_recover_invalid_email" :
          "licence_recover_failed";
        setRecoverError(t(errKey, lang));
      }
    } catch {
      setRecoverError(t("licence_network_error", lang));
    } finally {
      setRecoverLoading(false);
    }
  }

  // Copy the active licence code to the clipboard (the user can now see it,
  // so they can note it down and re-activate anywhere).
  async function copyCode() {
    if (!licence.key) return;
    try {
      await navigator.clipboard.writeText(licence.key);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — the code is select-all so manual copy works
    }
  }

  // Manual "export" button — same download, with explicit toasts.
  async function exportLicence() {
    try {
      const ok = await downloadBackupFile();
      showToast?.(t(ok ? "licence_export_ok" : "licence_export_empty", lang));
    } catch {
      showToast?.(t("licence_export_failed", lang));
    }
  }

  // Read a user-supplied JSON file and re-activate from it.
  function triggerImport() {
    fileInputRef.current?.click();
  }

  async function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file later
    if (!file) return;
    setLoading(true);
    setError(null);
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        setError(t("licence_import_malformed", lang));
        setLoading(false);
        return;
      }
      const result = await api.importLicense(parsed);
      if (result.ok) {
        const updated = await api.getLicense();
        onUpdate(updated);
        showToast?.(t("licence_import_ok", lang));
      } else {
        const errKey =
          result.error === "invalid_backup" ? "licence_import_malformed" :
          result.error === "network_error" ? "licence_network_error" :
          "licence_invalid";
        setError(t(errKey, lang));
      }
    } catch {
      setError(t("licence_import_malformed", lang));
    } finally {
      setLoading(false);
    }
  }

  const features = [
    { label: t("licence_feature_continuous", lang), free: false },
    { label: t("licence_feature_community", lang), free: false },
    { label: t("licence_feature_unlimited", lang), free: false },
  ];

  return (
    <Modal onClose={onClose}>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-white">{t("licence", lang)}</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-lg">
            ×
          </button>
        </div>

        {licence.active ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 p-3 rounded-xl bg-green-600/10 border border-green-600/20">
              <div className="w-2 h-2 rounded-full bg-green-400" />
              <span className="text-green-400 text-xs font-medium">
                {t("licence_active", lang)}
              </span>
            </div>
            <p className="text-xs text-gray-400">{t("licence_pro_limits", lang)}</p>

            {/* Visible licence code — so the user can note it and re-activate
                anywhere. The portable WFC code is the durable credential. */}
            {licence.key?.startsWith("WFC-") && (
              <div className="rounded-xl bg-gray-800/40 p-2.5 space-y-1.5">
                <p className="text-[10px] text-gray-400">{t("licence_code_label", lang)}</p>
                <button
                  onClick={copyCode}
                  title={t("licence_code_copy_hint", lang)}
                  className="w-full font-mono text-sm font-bold tracking-wider text-purple-300
                    bg-gray-900 border border-gray-700 rounded-lg px-2 py-2 hover:border-purple-500
                    transition-colors select-all"
                >
                  {licence.key}
                </button>
                <p className="text-[10px] text-gray-500 text-center">
                  {copied ? t("licence_code_copied", lang) : t("licence_code_copy_hint", lang)}
                </p>
              </div>
            )}

            {/* Backup / restore — saves the user from losing access on browser reinstall */}
            <div className="rounded-xl bg-gray-800/40 p-2.5 space-y-2">
              <p className="text-[10px] text-gray-400">{t("licence_backup_hint", lang)}</p>
              <div className="flex gap-1.5">
                <button
                  onClick={exportLicence}
                  className="flex-1 px-2 py-1.5 rounded-lg bg-gray-700 text-white text-[11px]
                    font-medium hover:bg-gray-600 transition-colors"
                >
                  {t("licence_export", lang)}
                </button>
                <button
                  onClick={triggerImport}
                  disabled={loading}
                  className="flex-1 px-2 py-1.5 rounded-lg bg-gray-700 text-white text-[11px]
                    font-medium hover:bg-gray-600 transition-colors disabled:opacity-50"
                >
                  {t("licence_import", lang)}
                </button>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json,.json"
                onChange={onFileChosen}
                style={{ display: "none" }}
              />
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Description */}
            <p className="text-xs text-gray-300">{t("licence_desc", lang)}</p>

            {/* Feature comparison */}
            <div className="rounded-xl bg-gray-800/40 p-2.5 space-y-1.5">
              <div className="flex items-center gap-2 text-[10px] text-gray-500 mb-1">
                <span className="flex-1" />
                <span className="w-10 text-center">Free</span>
                <span className="w-10 text-center text-purple-400 font-bold">Pro</span>
              </div>
              {features.map(({ label, free }) => (
                <div key={label} className="flex items-center gap-2 text-[10px]">
                  <span className="text-gray-400 flex-1">{label}</span>
                  <span className="w-10 text-center">{free ? <span className="text-green-400"><IconCheck /></span> : <span className="text-gray-600"><IconX /></span>}</span>
                  <span className="w-10 text-center text-green-400"><IconCheck /></span>
                </div>
              ))}
            </div>

            {/* Community stat */}
            {typeof communityTotal === "number" && communityTotal > 0 && (
              <p className="text-[10px] text-blue-400 text-center">
                {t("licence_community_stats", lang).replace("{0}", communityTotal.toLocaleString())}
              </p>
            )}

            {/* Launch badge + buy */}
            <div className="text-center space-y-1.5">
              <span className="text-[10px] bg-purple-500/20 text-purple-300 px-2 py-0.5 rounded-full font-medium">
                {t("licence_launch_badge", lang)}
              </span>
              <a
                href={PAYMENT_LINK}
                target="_blank"
                rel="noopener noreferrer"
                className="block w-full px-3 py-2.5 rounded-xl bg-purple-600 text-white text-xs font-bold
                  text-center hover:bg-purple-500 transition-colors"
              >
                <span className="line-through text-gray-400 text-[10px] mr-1">
                  {t("licence_original_price", lang)}EUR
                </span>
                {t("licence_launch_price", lang)}EUR — {t("licence_lifetime", lang)}
              </a>
              <p className="text-[10px] text-purple-300">{t("licence_price_anchor", lang)}</p>
              <p className="text-[10px] text-gray-400">{t("licence_guarantee", lang)}</p>
            </div>

            {/* Trust block — reassures a wary buyer before they pay */}
            <div className="rounded-xl bg-gray-800/40 p-2.5 space-y-1.5">
              {["licence_trust_dev", "licence_trust_refund", "licence_trust_local"].map((k) => (
                <div key={k} className="flex items-start gap-2 text-[10px] text-gray-300">
                  <span className="text-green-400 mt-0.5 shrink-0"><IconCheck /></span>
                  <span className="leading-snug">{t(k, lang)}</span>
                </div>
              ))}
            </div>

            {/* Activate with key */}
            <div className="space-y-2">
              <div className="flex gap-1.5">
                <input
                  type="text"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder={t("licence_key_placeholder", lang)}
                  className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5
                    text-xs text-white focus:border-purple-500 outline-none"
                  onKeyDown={(e) => e.key === "Enter" && activate()}
                />
                <button
                  onClick={activate}
                  disabled={loading || !key.trim()}
                  className="px-3 py-1.5 rounded-lg bg-gray-700 text-white text-xs font-medium
                    hover:bg-gray-600 transition-colors disabled:opacity-50"
                >
                  {loading ? "..." : t("licence_activate", lang)}
                </button>
              </div>
              {error && <p className="text-red-400 text-[10px]">{error}</p>}

              {/* Restore from a previously-saved backup file */}
              <div className="pt-1 text-center">
                <button
                  onClick={triggerImport}
                  disabled={loading}
                  className="text-[10px] text-purple-400 hover:text-purple-300 underline
                    disabled:opacity-50"
                >
                  {t("licence_import_link", lang)}
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/json,.json"
                  onChange={onFileChosen}
                  style={{ display: "none" }}
                />
              </div>
            </div>

            {/* Recover by email — for users who already bought but lost their
                local storage (reinstall, new browser, OS reset). */}
            <div className="space-y-1.5 pt-2 border-t border-gray-800/50">
              <p className="text-[10px] text-gray-400">{t("licence_recover_hint", lang)}</p>
              <div className="flex gap-1.5">
                <input
                  type="email"
                  value={recoverEmail}
                  onChange={(e) => setRecoverEmail(e.target.value)}
                  placeholder={t("licence_recover_placeholder", lang)}
                  className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5
                    text-xs text-white focus:border-purple-500 outline-none"
                  onKeyDown={(e) => e.key === "Enter" && recover()}
                />
                <button
                  onClick={recover}
                  disabled={recoverLoading || !recoverEmail.trim()}
                  className="px-3 py-1.5 rounded-lg bg-gray-700 text-white text-xs font-medium
                    hover:bg-gray-600 transition-colors disabled:opacity-50"
                >
                  {recoverLoading ? "..." : t("licence_recover_button", lang)}
                </button>
              </div>
              {recoverError && <p className="text-red-400 text-[10px]">{recoverError}</p>}
            </div>
          </div>
        )}

        {/* Support contact (always visible) */}
        <p className="text-[10px] text-gray-600 text-center pt-1 border-t border-gray-800/50">
          {t("support_help", lang)}{" "}
          <a
            href="mailto:contact@fredwav.com"
            className="text-purple-400 hover:text-purple-300 transition-colors"
          >
            contact@fredwav.com
          </a>
        </p>
    </Modal>
  );
}

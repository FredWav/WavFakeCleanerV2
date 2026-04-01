import { useState } from "react";
import { api } from "../lib/messaging";
import { t } from "../lib/i18n";
import { STRIPE_PAYMENT_LINK, LICENCE_PRICE } from "@shared/constants";
import type { LicenseInfo } from "@shared/types";

export default function LicencePanel({
  lang,
  licence,
  onUpdate,
  onClose,
}: {
  lang: string;
  licence: LicenseInfo;
  onUpdate: (l: LicenseInfo) => void;
  onClose: () => void;
}) {
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function activate() {
    if (!key.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.activateLicense(key.trim());
      if (result.ok) {
        const updated = await api.getLicense();
        onUpdate(updated);
      } else {
        setError(t("licence_invalid", lang));
      }
    } catch {
      setError(t("licence_invalid", lang));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-2"
      onClick={onClose}
    >
      <div
        className="bg-gray-900 rounded-2xl border border-gray-800 w-full max-w-sm p-4 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-white">{t("licence", lang)}</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-lg">
            x
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
          </div>
        ) : (
          <div className="space-y-3">
            {/* Free tier info */}
            <div className="p-3 rounded-xl bg-gray-800/50 space-y-1.5">
              <p className="text-xs text-gray-300">{t("licence_desc", lang)}</p>
              <p className="text-[10px] text-gray-500">{t("licence_free_limits", lang)}</p>
              <p className="text-[10px] text-purple-400">{t("licence_pro_limits", lang)}</p>
            </div>

            {/* Buy button */}
            <a
              href={STRIPE_PAYMENT_LINK}
              target="_blank"
              rel="noopener noreferrer"
              className="block w-full px-3 py-2.5 rounded-xl bg-purple-600 text-white text-xs font-bold
                text-center hover:bg-purple-500 transition-colors"
            >
              {t("licence_buy", lang)} — {LICENCE_PRICE}
            </a>

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
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

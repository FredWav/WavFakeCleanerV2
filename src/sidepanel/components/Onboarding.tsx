import { t } from "../lib/i18n";
import Modal from "./ui/Modal";
import Button from "./ui/Button";

export default function Onboarding({
  lang,
  onDismiss,
  onOpenSettings,
}: {
  lang: string;
  onDismiss: () => void;
  onOpenSettings: () => void;
}) {
  function handleDismiss() {
    localStorage.setItem("wav_onboarding_done", "1");
    onDismiss();
  }

  const steps = [
    { num: 1, text: t("onboarding_step1", lang), action: onOpenSettings },
    { num: 2, text: t("onboarding_step2", lang) },
    { num: 3, text: t("onboarding_step3", lang) },
  ];

  return (
    <Modal onClose={handleDismiss} dim="bg-black/70" className="p-5 space-y-4">
        <h2 className="text-sm font-bold text-white text-center">
          {t("onboarding_title", lang)}
        </h2>
        {/* D2 : signature de marque — l'argument « créateur identifiable » doit se
            voir dès l'accueil, pas seulement se lire ailleurs. */}
        <p className="text-[11px] text-gray-500 text-center -mt-2">{t("onboarding_signature", lang)}</p>

        {/* Explique CE QUE fait le produit et POURQUOI les faux comptent, avant les
            étapes pratiques — sinon un débutant n'a aucune raison de s'y intéresser. */}
        <div className="space-y-1.5 text-[11px] text-gray-300 leading-snug">
          <p>{t("onboarding_intro_1", lang)}</p>
          <p>{t("onboarding_intro_2", lang)}</p>
          <p className="text-green-300">{t("onboarding_intro_3", lang)}</p>
        </div>

        <div className="space-y-3">
          {steps.map(({ num, text, action }) => (
            <div
              key={num}
              className={`flex items-start gap-3 p-2.5 rounded-xl ${
                action ? "bg-purple-600/10 border border-purple-600/20 cursor-pointer hover:bg-purple-600/20" : "bg-gray-800/50"
              }`}
              onClick={action ? () => { action(); handleDismiss(); } : undefined}
            >
              <div className="w-6 h-6 rounded-full bg-purple-600 flex items-center justify-center flex-shrink-0">
                <span className="text-[11px] text-white font-bold">{num}</span>
              </div>
              <p className="text-xs text-gray-300 pt-0.5">{text}</p>
            </div>
          ))}
        </div>

        <p className="text-[11px] text-gray-500 leading-snug text-center">
          {t("fetch_limit_note", lang)}
        </p>

        <Button onClick={handleDismiss} className="w-full rounded-xl py-2 font-bold">
          {t("onboarding_dismiss", lang)}
        </Button>
    </Modal>
  );
}

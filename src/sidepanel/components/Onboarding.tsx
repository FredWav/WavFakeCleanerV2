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
    <Modal onClose={handleDismiss} dim="bg-ink/40" className="p-5 space-y-4">
        <h2 className="text-sm font-bold text-ink text-center">
          {t("onboarding_title", lang)}
        </h2>
        {/* D2 : signature de marque — l'argument « créateur identifiable » doit se
            voir dès l'accueil, pas seulement se lire ailleurs. */}
        <p className="text-[11px] text-ink-faint text-center -mt-2">{t("onboarding_signature", lang)}</p>

        {/* Explique CE QUE fait le produit et POURQUOI les faux comptent, avant les
            étapes pratiques — sinon un débutant n'a aucune raison de s'y intéresser. */}
        <div className="space-y-1.5 text-[11px] text-ink-soft leading-snug">
          <p>{t("onboarding_intro_1", lang)}</p>
          <p>{t("onboarding_intro_2", lang)}</p>
          <p className="text-clean font-medium">{t("onboarding_intro_3", lang)}</p>
        </div>

        <div className="space-y-3">
          {steps.map(({ num, text, action }) => (
            <div
              key={num}
              className={`flex items-start gap-3 p-2.5 rounded-xl ${
                action ? "bg-accent/10 border border-accent/20 cursor-pointer hover:bg-accent/20" : "bg-surface-2"
              }`}
              onClick={action ? () => { action(); handleDismiss(); } : undefined}
            >
              <div className="w-6 h-6 rounded-full bg-accent flex items-center justify-center flex-shrink-0">
                <span className="text-[11px] text-accent-ink font-bold">{num}</span>
              </div>
              <p className="text-xs text-ink-soft pt-0.5">{text}</p>
            </div>
          ))}
        </div>

        <p className="text-[11px] text-ink-faint leading-snug text-center">
          {t("fetch_limit_note", lang)}
        </p>

        <Button onClick={handleDismiss} className="w-full rounded-xl py-2 font-bold">
          {t("onboarding_dismiss", lang)}
        </Button>
    </Modal>
  );
}

import { t } from "../lib/i18n";

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
    <div
      className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-2"
      onClick={handleDismiss}
    >
      <div
        className="bg-gray-900 rounded-2xl border border-gray-800 w-full max-w-sm p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-bold text-white text-center">
          {t("onboarding_title", lang)}
        </h2>

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

        <button
          onClick={handleDismiss}
          className="w-full px-3 py-2 rounded-xl bg-purple-600 text-white text-xs font-bold
            hover:bg-purple-500 transition-colors"
        >
          {t("onboarding_dismiss", lang)}
        </button>
      </div>
    </div>
  );
}

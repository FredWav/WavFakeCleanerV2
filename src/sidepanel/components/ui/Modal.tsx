import { useEffect, type ReactNode } from "react";

/**
 * Shared modal shell — the overlay/card pattern that was duplicated across
 * SettingsPanel, LicencePanel and Onboarding. Click outside or Escape closes;
 * the card pops in (motion-preference aware via globals.css).
 */
export default function Modal({
  onClose,
  children,
  className = "p-4 space-y-3",
  dim = "bg-black/60",
}: {
  onClose: () => void;
  children: ReactNode;
  /** Inner card padding/layout classes. */
  className?: string;
  /** Backdrop darkness (Onboarding uses a stronger dim). */
  dim?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className={`fixed inset-0 ${dim} backdrop-blur-[2px] z-50 flex items-center justify-center p-2 animate-overlay-in`}
      onClick={onClose}
    >
      <div
        className={`bg-gray-900 rounded-2xl border border-gray-800 w-full max-w-sm animate-modal-pop ${className}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

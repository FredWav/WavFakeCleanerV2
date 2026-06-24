import { useEffect, useRef } from "react";

/**
 * Un toast empilable. Le positionnement (conteneur fixe en bas) est géré par le
 * parent (App) qui en affiche une file ; ce composant ne rend que la pastille et
 * gère son auto-effacement. onDismiss est lu via une ref pour que le timer ne se
 * réinitialise pas à chaque re-render du parent (stats rafraîchies toutes les 3s).
 */
export default function Toast({
  message,
  onDismiss,
}: {
  message: string | null;
  onDismiss: () => void;
}) {
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    if (!message) return;
    const id = setTimeout(() => onDismissRef.current(), 2500);
    return () => clearTimeout(id);
  }, [message]);

  if (!message) return null;

  return (
    <div
      onClick={onDismiss}
      className="bg-gray-800 border border-gray-700 rounded-xl px-4 py-2 text-xs text-gray-200
        shadow-lg pointer-events-auto cursor-pointer animate-toast-up max-w-full"
    >
      {message}
    </div>
  );
}

import { useEffect } from "react";

export default function Toast({
  message,
  onDismiss,
}: {
  message: string | null;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (!message) return;
    const id = setTimeout(onDismiss, 2500);
    return () => clearTimeout(id);
  }, [message, onDismiss]);

  if (!message) return null;

  return (
    <div
      className="fixed bottom-3 left-3 right-3 z-50 flex justify-center pointer-events-none"
    >
      <div
        onClick={onDismiss}
        className="bg-gray-800 border border-gray-700 rounded-xl px-4 py-2 text-xs text-gray-200
          shadow-lg pointer-events-auto cursor-pointer animate-fade-in"
      >
        {message}
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { t } from "../lib/i18n";
import type { LogEntry } from "@shared/types";

const levelStyles: Record<string, { color: string; icon: string }> = {
  INFO: { color: "text-blue-400", icon: ">" },
  WARNING: { color: "text-yellow-400", icon: "!" },
  ERROR: { color: "text-red-400", icon: "x" },
  DEBUG: { color: "text-gray-500", icon: "~" },
};

function formatTs(iso: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "";
  }
}

function buildReport(logs: LogEntry[], lang: string): string {
  const version = chrome.runtime?.getManifest?.().version ?? "unknown";
  const header = [
    `Wav Fake Cleaner — diagnostic report`,
    `version: ${version}`,
    `lang:    ${lang}`,
    `when:    ${new Date().toISOString()}`,
    `logs:    ${logs.length}`,
    `---`,
  ].join("\n");
  const body = logs
    .map((e) => `${e.ts} [${e.level}] (${e.category}) ${e.message}`)
    .join("\n");
  return `${header}\n${body || "(no logs)"}\n`;
}

export default function LogConsole({
  logs,
  connected,
  onClear,
  lang,
}: {
  logs: LogEntry[];
  connected: boolean;
  onClear: () => void;
  lang: string;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs.length]);

  async function handleCopy() {
    const text = buildReport(logs, lang);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Fallback for environments without clipboard permission
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
      ta.remove();
    }
  }

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 flex flex-col h-48">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-800">
        <div className="flex items-center gap-2">
          <span
            className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-green-400" : "bg-red-400"}`}
          />
          <span className="text-xs font-medium">{t("logs", lang)}</span>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handleCopy}
            className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors"
            title={t("copy_report_hint", lang)}
          >
            {copied ? t("copied", lang) : t("copy_report", lang)}
          </button>
          <button
            onClick={onClear}
            className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors"
          >
            {t("clear", lang)}
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-2 text-[11px] space-y-0.5">
        {logs.length === 0 ? (
          <div className="text-gray-600 text-center mt-6">{t("no_logs", lang)}</div>
        ) : (
          logs.map((entry, i) => {
            const style = levelStyles[entry.level] || levelStyles.INFO;
            return (
              <div key={i} className="flex gap-1.5 leading-relaxed">
                <span className="text-gray-600 shrink-0 text-[10px]">{formatTs(entry.ts)}</span>
                <span className={`shrink-0 ${style.color}`}>{style.icon}</span>
                <span className="text-gray-300">{entry.message}</span>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

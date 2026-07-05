import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { t, getStoredLang } from "../sidepanel/lib/i18n";

function Popup() {
  const lang = getStoredLang();

  function openSidePanel() {
    // Open the side panel
    chrome.sidePanel
      .open({ windowId: chrome.windows?.WINDOW_ID_CURRENT })
      .catch(() => {
        // Fallback: open threads.net
        chrome.tabs.create({ url: "https://www.threads.net" });
      });
    window.close();
  }

  function openThreads() {
    chrome.tabs.create({ url: "https://www.threads.net" });
    window.close();
  }

  const logoUrl = chrome.runtime?.getURL?.("icons/icon128.png") ?? "icons/icon128.png";
  return (
    <div className="w-64 p-4 bg-ground text-ink space-y-3">
      <div className="flex items-center gap-2">
        <img src={logoUrl} alt="Wav Fake Cleaner" className="w-7 h-7 rounded-md shrink-0" />
        <div>
          <h1 className="text-sm font-bold leading-none">Wav Fake Cleaner</h1>
          <p className="text-[11px] text-ink-faint">
            by{" "}
            <a
              href="https://fredwav.com/contact"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent-deep hover:text-accent transition-colors"
            >
              Fred Wav
            </a>
          </p>
        </div>
      </div>
      <div className="space-y-2">
        <button
          onClick={openSidePanel}
          className="w-full px-3 py-2 rounded-lg bg-accent text-accent-ink text-xs font-bold
            hover:bg-accent-hover transition-colors"
        >
          {t("popup_open_panel", lang)}
        </button>
        <button
          onClick={openThreads}
          className="w-full px-3 py-2 rounded-lg bg-surface border border-line text-ink text-xs
            hover:bg-surface-2 transition-colors"
        >
          {t("popup_open_threads", lang)}
        </button>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Popup />
  </StrictMode>
);

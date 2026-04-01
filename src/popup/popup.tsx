import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

function Popup() {
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

  return (
    <div className="w-64 p-4 bg-gray-950 text-white space-y-3">
      <h1 className="text-sm font-bold">Wav Fake Cleaner V2</h1>
      <p className="text-[10px] text-gray-500">
        by{" "}
        <a
          href="https://www.threads.net/@fredwavoff"
          target="_blank"
          rel="noopener noreferrer"
          className="text-purple-400"
        >
          Fred Wav
        </a>
      </p>
      <div className="space-y-2">
        <button
          onClick={openSidePanel}
          className="w-full px-3 py-2 rounded-lg bg-purple-600 text-white text-xs font-medium
            hover:bg-purple-500 transition-colors"
        >
          Ouvrir le panneau / Open Panel
        </button>
        <button
          onClick={openThreads}
          className="w-full px-3 py-2 rounded-lg bg-gray-800 text-gray-300 text-xs
            hover:text-white transition-colors"
        >
          Ouvrir Threads / Open Threads
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

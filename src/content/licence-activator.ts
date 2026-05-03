/**
 * Content script injecté sur la page de succès Stripe (wavfakecleaner.fred-olalde.workers.dev/success).
 * Lit le session_id dans l'URL et active la licence automatiquement.
 *
 * Sécurité : le sessionId vient de l'URL et ne doit JAMAIS être interpolé dans
 * de l'HTML brut (XSS). On construit le DOM avec textContent / setAttribute.
 */

(async () => {
  const url = new URL(window.location.href);
  const sessionId = url.searchParams.get("session_id");
  const statusEl = document.getElementById("wfc-status");

  function clear(): void {
    if (!statusEl) return;
    while (statusEl.firstChild) statusEl.removeChild(statusEl.firstChild);
  }

  function setState(state: "success" | "error" | "no-id"): void {
    statusEl?.setAttribute("data-state", state);
  }

  function makeDiv(text: string, style: string): HTMLDivElement {
    const d = document.createElement("div");
    d.setAttribute("style", style);
    d.textContent = text;
    return d;
  }

  function showCopyableId(id: string): HTMLDivElement {
    // Strict allowlist: Stripe checkout session IDs only contain
    // [a-zA-Z0-9_]. Reject anything else outright.
    const safeId = /^cs_(live|test)_[A-Za-z0-9]{20,80}$/.test(id) ? id : "";
    const box = document.createElement("div");
    box.setAttribute(
      "style",
      "background:#0f0f11;border:1px solid #3b3b52;border-radius:8px;padding:10px;font-family:monospace;color:#c084fc;word-break:break-all;margin-top:6px;cursor:pointer"
    );
    box.textContent = safeId || "(invalid id)";
    if (safeId) {
      box.addEventListener("click", () => {
        navigator.clipboard.writeText(safeId).catch(() => { /* ignore */ });
      });
    }
    return box;
  }

  function renderError(headerText: string): void {
    if (!statusEl) return;
    clear();
    statusEl.appendChild(makeDiv(headerText, "color:#fbbf24"));
    statusEl.appendChild(
      makeDiv(
        "Copie cet ID dans le champ d'activation de l'extension :",
        "color:#9ca3af;font-size:.8rem;margin-top:10px"
      )
    );
    if (sessionId) statusEl.appendChild(showCopyableId(sessionId));
    statusEl.appendChild(
      makeDiv("Clique pour copier", "color:#6b7280;font-size:.75rem;margin-top:4px")
    );
  }

  if (!sessionId || !sessionId.startsWith("cs_")) {
    setState("no-id");
    if (statusEl) {
      clear();
      statusEl.appendChild(makeDiv("Session ID manquant.", "color:#f87171"));
    }
    return;
  }

  try {
    const result = (await chrome.runtime.sendMessage({
      type: "ACTIVATE_LICENSE",
      payload: { key: sessionId },
    })) as { ok: boolean; error?: string } | undefined;

    if (result?.ok) {
      setState("success");
      if (statusEl) {
        clear();
        statusEl.appendChild(
          makeDiv("✓ Licence activée !", "color:#4ade80;font-size:1.1rem;font-weight:bold")
        );
        statusEl.appendChild(
          makeDiv(
            "Tu peux fermer cet onglet et rouvrir l'extension.",
            "color:#9ca3af;font-size:.85rem;margin-top:8px"
          )
        );
      }
    } else {
      setState("error");
      renderError("Activation automatique échouée.");
    }
  } catch {
    // Extension installée mais le service worker ne répond pas
    setState("error");
    renderError("Extension non détectée dans ce navigateur.");
  }
})();

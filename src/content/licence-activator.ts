/**
 * Content script injecté sur la page de succès Stripe (wavfakecleaner.fred-olalde.workers.dev/success).
 * Active la licence automatiquement à partir du code WFC-XXXX-XXXX (préféré, depuis 2.2)
 * ou du session_id Stripe (fallback rétro-compatible).
 *
 * Sécurité : toutes les valeurs lisibles depuis l'URL ou le DOM sont validées
 * contre une regex stricte avant d'être affichées. JAMAIS d'interpolation HTML
 * brute (XSS).
 */

const STRIPE_SESSION_RE = /^cs_(live|test)_[A-Za-z0-9]{20,80}$/;
const WFC_CODE_RE = /^WFC-[A-Z2-9]{4}-[A-Z2-9]{4}$/;

(async () => {
  const url = new URL(window.location.href);
  const statusEl = document.getElementById("wfc-status");

  // Prefer the short code embedded in the success page (issued by the worker).
  // Fall back to the URL session_id for old success pages or unusual redirects.
  const codeFromDom = (statusEl?.getAttribute("data-license-code") || "").trim();
  const sessionId = url.searchParams.get("session_id");
  const code = WFC_CODE_RE.test(codeFromDom) ? codeFromDom : "";
  const activationKey = code || (sessionId && STRIPE_SESSION_RE.test(sessionId) ? sessionId : "");

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

  function showCopyable(value: string): HTMLDivElement {
    const box = document.createElement("div");
    box.setAttribute(
      "style",
      "background:#0f0f11;border:1px solid #3b3b52;border-radius:8px;padding:10px;font-family:monospace;color:#c084fc;word-break:break-all;margin-top:6px;cursor:pointer"
    );
    box.textContent = value;
    box.addEventListener("click", () => {
      navigator.clipboard.writeText(value).catch(() => { /* ignore */ });
    });
    return box;
  }

  function renderError(headerText: string): void {
    if (!statusEl) return;
    clear();
    statusEl.appendChild(makeDiv(headerText, "color:#fbbf24"));
    // Show the short code if we have one, otherwise the session ID. Both
    // have already been format-validated above.
    const display = code || (sessionId && STRIPE_SESSION_RE.test(sessionId) ? sessionId : "");
    if (display) {
      statusEl.appendChild(
        makeDiv(
          "Copie ce code dans le champ d'activation de l'extension :",
          "color:#9ca3af;font-size:.8rem;margin-top:10px",
        ),
      );
      statusEl.appendChild(showCopyable(display));
      statusEl.appendChild(
        makeDiv("Clique pour copier", "color:#6b7280;font-size:.75rem;margin-top:4px"),
      );
    }
  }

  if (!activationKey) {
    setState("no-id");
    if (statusEl) {
      clear();
      statusEl.appendChild(makeDiv("Code de licence manquant.", "color:#f87171"));
    }
    return;
  }

  try {
    const result = (await chrome.runtime.sendMessage({
      type: "ACTIVATE_LICENSE",
      payload: { key: activationKey },
    })) as { ok: boolean; error?: string } | undefined;

    if (result?.ok) {
      setState("success");
      if (statusEl) {
        clear();
        statusEl.appendChild(
          makeDiv("✓ Licence activée !", "color:#4ade80;font-size:1.1rem;font-weight:bold"),
        );
        statusEl.appendChild(
          makeDiv(
            "Tu peux fermer cet onglet et rouvrir l'extension.",
            "color:#9ca3af;font-size:.85rem;margin-top:8px",
          ),
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

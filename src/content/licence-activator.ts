/**
 * Content script injecté sur la page de succès Stripe (wavfakecleaner.fred-olalde.workers.dev/success).
 * Lit le session_id dans l'URL et active la licence automatiquement.
 */

(async () => {
  const url = new URL(window.location.href);
  const sessionId = url.searchParams.get("session_id");
  const statusEl = document.getElementById("wfc-status");

  function setStatus(html: string) {
    if (statusEl) statusEl.innerHTML = html;
  }

  if (!sessionId || !sessionId.startsWith("cs_")) {
    setStatus(`<div style="color:#f87171">Session ID manquant.</div>`);
    return;
  }

  setStatus(`<div style="color:#a855f7">Activation de ta licence en cours…</div>`);

  try {
    const result = await chrome.runtime.sendMessage({
      type: "ACTIVATE_LICENSE",
      payload: { key: sessionId },
    }) as { ok: boolean; error?: string } | undefined;

    if (result?.ok) {
      setStatus(`
        <div style="color:#4ade80;font-size:1.1rem;font-weight:bold">✓ Licence activée !</div>
        <div style="color:#9ca3af;font-size:.85rem;margin-top:8px">Tu peux fermer cet onglet et rouvrir l'extension.</div>
      `);
    } else {
      // Fallback : affiche l'ID pour copier/coller manuel
      setStatus(`
        <div style="color:#fbbf24">Activation automatique échouée (extension non ouverte ?)</div>
        <div style="color:#9ca3af;font-size:.8rem;margin-top:10px">Copie cet ID dans le champ d'activation de l'extension :</div>
        <div style="background:#0f0f11;border:1px solid #3b3b52;border-radius:8px;padding:10px;font-family:monospace;
             color:#c084fc;word-break:break-all;margin-top:6px;cursor:pointer"
             onclick="navigator.clipboard.writeText('${sessionId}')">${sessionId}</div>
        <div style="color:#6b7280;font-size:.75rem;margin-top:4px">Clique pour copier</div>
      `);
    }
  } catch {
    // Extension pas installée ou page ouverte sans l'extension active
    setStatus(`
      <div style="color:#fbbf24">Extension non détectée dans ce navigateur.</div>
      <div style="color:#9ca3af;font-size:.8rem;margin-top:10px">Copie cet ID dans le champ d'activation de l'extension :</div>
      <div style="background:#0f0f11;border:1px solid #3b3b52;border-radius:8px;padding:10px;font-family:monospace;
           color:#c084fc;word-break:break-all;margin-top:6px;cursor:pointer"
           onclick="navigator.clipboard.writeText('${sessionId}')">${sessionId}</div>
      <div style="color:#6b7280;font-size:.75rem;margin-top:4px">Clique pour copier</div>
    `);
  }
})();

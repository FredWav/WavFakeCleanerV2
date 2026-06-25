/**
 * Diagnostic de récupération (TEMPORAIRE — à retirer une fois le bug tranché).
 *
 * Le fetch des abonnés tourne dans un onglet de fond CACHÉ (active:false) dont la
 * console est pénible à inspecter. dbg() écrit donc à la fois dans la console de
 * l'onglet ET relaie le message au service worker via LOG_FROM_CONTENT — qui le
 * rebroadcast en LOG_EVENT, visible dans le panneau « Activité » du side panel.
 *
 * Sûr en MAIN world (le pont) : si chrome.runtime n'existe pas, on se contente
 * de la console sans planter.
 */
export function dbg(
  category: string,
  message: string,
  level: "INFO" | "WARNING" | "ERROR" = "INFO",
): void {
  try {
    console.log(`[WFC:${category}] ${message}`);
  } catch {
    /* ignore */
  }
  try {
    chrome.runtime
      .sendMessage({ type: "LOG_FROM_CONTENT", payload: { level, category, message } })
      .catch(() => {});
  } catch {
    /* pas de chrome.runtime (MAIN world) — console seule */
  }
}

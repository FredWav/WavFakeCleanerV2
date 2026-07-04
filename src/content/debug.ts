/**
 * Canal de diagnostic du content-script.
 *
 * Le fetch des abonnés tourne dans un onglet de fond CACHÉ (active:false) dont la
 * console est pénible à inspecter. dbg() relaie donc chaque message au service
 * worker via LOG_FROM_CONTENT — qui le rebroadcast en LOG_EVENT, visible dans le
 * panneau « Activité » du side panel. C'est le canal propre, filtrable et destiné
 * au support.
 *
 * La sortie console (bruyante, visible dans la console de la page Threads de
 * l'utilisateur final) est GATÉE par CONSOLE_DEBUG et coupée en production. La
 * passer à true en développement pour retrouver les traces dans la console.
 *
 * Sûr en MAIN world (le pont) : si chrome.runtime n'existe pas, on se contente
 * de la console — laquelle reste silencieuse tant que CONSOLE_DEBUG est false.
 */
const CONSOLE_DEBUG = false;

export function dbg(
  category: string,
  message: string,
  level: "INFO" | "WARNING" | "ERROR" = "INFO",
): void {
  if (CONSOLE_DEBUG) {
    try {
      console.log(`[WFC:${category}] ${message}`);
    } catch {
      /* ignore */
    }
  }
  try {
    chrome.runtime
      .sendMessage({ type: "LOG_FROM_CONTENT", payload: { level, category, message } })
      .catch(() => {});
  } catch {
    /* pas de chrome.runtime (MAIN world) — console seule */
  }
}

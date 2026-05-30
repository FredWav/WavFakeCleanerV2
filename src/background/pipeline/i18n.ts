/**
 * Pipeline i18n — message catalog and locale loader.
 *
 * Service workers have no localStorage, so we load the user's chosen
 * language from chrome.storage.local at boot and on demand.
 */

let currentLang = "fr";

export async function loadLang(): Promise<void> {
  try {
    const result = await chrome.storage.local.get("wav_lang");
    currentLang = result.wav_lang || "fr";
  } catch {
    currentLang = "fr";
  }
}

export function getCurrentLang(): string {
  return currentLang;
}

const MSG: Record<string, Record<string, string>> = {
  no_username:          { fr: "Aucun nom d'utilisateur configuré", en: "No username configured" },
  fetch_start:          { fr: "Récupération de tes followers (@{0})…", en: "Fetching your followers list (@{0})…" },
  fetch_found:          { fr: "{0} followers trouvés, sauvegarde…", en: "{0} followers found, saving…" },
  fetch_done:           { fr: "Terminé : {0} followers récupérés, {1} nouveaux — clique Nettoyer pour les scanner", en: "Done: {0} followers fetched, {1} new — click Clean to analyze them" },
  fetch_truncated:      { fr: "{0} abonnés récupérés — limite d'une passe (~5000 max) atteinte. Les très gros comptes ne sont pas entièrement couverts en une seule fois.", en: "{0} followers fetched — single-pass limit (~5000 max) reached. Very large accounts aren't fully covered in one go." },
  fetch_error:          { fr: "Erreur récupération : {0}", en: "Fetch error: {0}" },
  fetch_failed:         { fr: "Échec récupération : {0}", en: "Fetch failed: {0}" },
  fetch_retry_fail:     { fr: "Échec après 3 tentatives — canal de messages instable", en: "Fetch failed after 3 retries — message channel keeps closing" },
  msg_channel_err:      { fr: "Erreur canal (tentative {0}/3), réinjection…", en: "Message channel error (attempt {0}/3), re-injecting…" },
  bg_tab_created:       { fr: "Onglet arrière-plan créé (id={0})", en: "Background tab created (id={0})" },
  bg_tab_closed:        { fr: "Onglet arrière-plan fermé", en: "Background tab closed" },
  cs_injected:          { fr: "Script injecté avec succès (onglet {0})", en: "Content script injected successfully on tab {0}" },
  cs_inject_fail:       { fr: "Échec injection script : {0}", en: "Failed to inject content script: {0}" },
  cs_active:            { fr: "Script déjà actif (onglet {0})", en: "Content script already active on tab {0}" },
  threads_tab:          { fr: "Onglet Threads trouvé : id={0}", en: "Found Threads tab: id={0}" },
  send_fail:            { fr: "Envoi message échoué : {0}", en: "sendMessage failed: {0}" },
  scan_not_found:       { fr: "@{0} : INTROUVABLE → score=100 FAKE", en: "@{0}: NOT FOUND → score=100 FAKE" },
  scan_result:          { fr: "@{0} : score={1} {2}", en: "@{0}: score={1} {2}" },
  scan_error:           { fr: "@{0} : {1}", en: "@{0}: {1}" },
  scan_no_data:         { fr: "@{0} : aucune donnée retournée", en: "@{0}: no data returned" },
  scan_done:            { fr: "Analyse terminée : {0} profils analysés, {1} fakes détectés", en: "Analysis complete: {0} profiles analyzed, {1} fakes detected" },
  scan_rate_limit:      { fr: "@{0} : limite 429 (blocages : {1})", en: "@{0}: 429 rate limit (blocked: {1})" },
  scan_tab_lost:        { fr: "@{0} : onglet perdu ({1}), recréation…", en: "@{0}: tab lost ({1}), will recreate…" },
  scan_slowdown:        { fr: "Threads semble nous ralentir. Pause de 5 minutes…", en: "Threads seems to be slowing us down. Pausing for 5 minutes…" },
  rate_limited:         { fr: "Limité — {0}/{1} par heure — pause", en: "Rate limited — {0}/{1} per hour — pausing" },
  auto_stop:            { fr: "Arrêt auto : {0}", en: "Auto-stop: {0}" },
  no_fakes:             { fr: "Aucun faux follower à supprimer.", en: "No fake followers to remove." },
  clean_start:          { fr: "Suppression de {0} faux followers…", en: "Removing {0} fake followers…" },
  clean_removed:        { fr: "@{0} supprimé", en: "@{0} removed" },
  clean_blocked:        { fr: "Threads bloque temporairement les suppressions. Attends 30 minutes.", en: "Threads is temporarily blocking removals. Please wait 30 minutes." },
  clean_wait:           { fr: "Attente 60s avant nouvelle tentative…", en: "Waiting 60s before retrying…" },
  clean_fail:           { fr: "@{0} : échec — {1}", en: "@{0}: failed — {1}" },
  clean_blocked_user:   { fr: "@{0} : bloqué par Threads", en: "@{0}: blocked by Threads" },
  clean_done:           { fr: "Suppression terminée : {0} supprimés{1}", en: "Clean done: {0} removed{1}" },
  clean_stopped:        { fr: " (ARRÊTÉ : blocage Threads détecté)", en: " (STOPPED: Threads blocking detected)" },
  rate_limited_clean:   { fr: "Limité — arrêt suppression", en: "Rate limited — stopping clean" },
  cs_injecting:         { fr: "Script non trouvé sur l'onglet {0}, injection en cours…", en: "Content script not found on tab {0}, injecting dynamically…" },
  tab_recreated:        { fr: "Onglet arrière-plan {0} perdu, recréation…", en: "Background tab {0} lost, recreating…" },
  cycle_start:          { fr: "Nettoyage : {0} profils à traiter…", en: "Cleaning: {0} profiles to process…" },
  cycle_start_wait:     { fr: "Démarrage dans {0}s…", en: "Starting in {0}s…" },
  cycle_visit:          { fr: "@{0} : visite du profil…", en: "@{0}: visiting profile…" },
  cycle_fake_removed:   { fr: "@{0} : score={1} FAKE → supprimé", en: "@{0}: score={1} FAKE → removed" },
  cycle_fake_fail:      { fr: "@{0} : score={1} FAKE → échec suppression ({2})", en: "@{0}: score={1} FAKE → removal failed ({2})" },
  cycle_review:         { fr: "@{0} : score={1} → à vérifier", en: "@{0}: score={1} → to review" },
  cycle_ok:             { fr: "@{0} : score={1} → OK", en: "@{0}: score={1} → OK" },
  cycle_not_found:      { fr: "@{0} : INTROUVABLE → supprimé", en: "@{0}: NOT FOUND → removed" },
  cycle_done:           { fr: "Cycle terminé : {0} vérifiés, {1} supprimés, {2} à vérifier", en: "Cycle done: {0} checked, {1} removed, {2} to review" },
  cycle_limit:          { fr: "Limite quotidienne atteinte (1 cycle/jour). Passe en licence pour le mode continu.", en: "Daily limit reached (1 cycle/day). Upgrade to license for continuous mode." },
  cycle_no_pending:     { fr: "Aucun follower en attente. Lance d'abord une récupération.", en: "No pending followers. Run a fetch first." },
  continuous_start:     { fr: "Mode continu démarré", en: "Continuous mode started" },
  continuous_stop:      { fr: "Mode continu arrêté", en: "Continuous mode stopped" },
  continuous_pause:     { fr: "Pause {0}s avant le prochain cycle…", en: "Pause {0}s before next cycle…" },
  continuous_fetch:     { fr: "Re-récupération des followers…", en: "Re-fetching followers…" },
  continuous_idle:      { fr: "Compte propre — rien à nettoyer. Prochaine vérification dans ~{0} min.", en: "Account clean — nothing to remove. Next check in ~{0} min." },
  cycle_auto_skip:     { fr: "{0} profil(s) résolus automatiquement (pré-score)", en: "{0} profile(s) auto-resolved (pre-score)" },
  cycle_remove_only:   { fr: "{0} profil(s) déjà scorés fake — suppression directe (sans re-scan)", en: "{0} profile(s) already scored fake — removing directly (no re-scan)" },
  scan_channel_lost:   { fr: "@{0} : canal perdu (page Threads crashée ?), re-navigation…", en: "@{0}: channel lost (Threads page crashed?), re-navigating…" },
  threads_error_page:  { fr: "@{0} : page d'erreur Threads — pause {1}s…", en: "@{0}: Threads error page — pausing {1}s…" },
  threads_error_page_skip: { fr: "@{0} : page d'erreur persistante, skip → retry prochain cycle", en: "@{0}: persistent error page, skip → retry next cycle" },
  threads_hard_429:    { fr: "429 massif détecté — pause longue de {0} minutes", en: "Hard 429 detected — long pause of {0} minutes" },
  continuous_session_break: { fr: "Session de {1} cycles — pause obligatoire de {0} min pour éviter le 429", en: "Session of {1} cycles — mandatory {0} min break to avoid 429" },
  continuous_session_resume: { fr: "Reprise après pause obligatoire", en: "Resuming after mandatory break" },
  cycle_remove_retry:  { fr: "@{0} : menu introuvable, retry {1}/2…", en: "@{0}: menu not found, retry {1}/2…" },
  cycle_remove_retry_nav: { fr: "@{0} : re-navigation vers le profil (dernier essai)…", en: "@{0}: re-navigating to profile (last attempt)…" },
  notification_fakes_found: { fr: "Wav Fake Cleaner a detecte {0} faux followers", en: "Wav Fake Cleaner detected {0} fake followers" },
  // User-facing mappings of internal fetch error codes (shown in the side panel)
  err_no_username:           { fr: "Aucun nom d'utilisateur configuré dans les paramètres.", en: "No username configured in settings." },
  err_followers_button:      { fr: "Bouton « Followers » introuvable. Vérifie que tu es connecté(e) et que ton profil est bien public.", en: "“Followers” button not found. Check that you're logged in and your profile is public." },
  err_no_container:          { fr: "Liste des followers non détectée. Recharge la page Threads (Ctrl+Shift+R) et réessaie. Si ça persiste, ferme et rouvre Threads.", en: "Followers list not detected. Reload the Threads page (Ctrl+Shift+R) and try again. If it persists, close and reopen Threads." },
  err_no_container_no_links: { fr: "Threads n'a pas chargé la liste des followers à temps. Recharge la page et réessaie.", en: "Threads didn't load the followers list in time. Reload the page and try again." },
  err_no_container_too_small:{ fr: "Trop peu de followers visibles pour scroller. Réessaie après avoir attendu quelques secondes sur la page.", en: "Too few followers visible to scroll. Wait a few seconds on the page and retry." },
  err_msg_channel:           { fr: "Communication interrompue avec Threads (3 tentatives). Recharge la page et réessaie.", en: "Communication with Threads interrupted (3 retries). Reload the page and try again." },
  err_generic:               { fr: "Erreur inattendue : {0}", en: "Unexpected error: {0}" },
};

/**
 * Format a translated message with positional placeholders.
 *
 * Usage: m("scan_result", username, score, label)
 */
export function m(key: string, ...args: (string | number)[]): string {
  const tpl = MSG[key]?.[currentLang] || MSG[key]?.fr || key;
  return tpl.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? ""));
}

/**
 * Map an internal fetch error code (and optional reason) to a user-friendly
 * message. Falls back to the generic template if no specific mapping exists.
 */
export function fetchErrorToUserMessage(code: string, reason?: string): string {
  switch (code) {
    case "no_username":
      return m("err_no_username");
    case "followers_button_not_found":
      return m("err_followers_button");
    case "scroll_container_not_found":
      if (reason === "no_links") return m("err_no_container_no_links");
      if (reason === "container_too_small") return m("err_no_container_too_small");
      return m("err_no_container");
    case "message_channel_closed":
      return m("err_msg_channel");
    default:
      return m("err_generic", code);
  }
}

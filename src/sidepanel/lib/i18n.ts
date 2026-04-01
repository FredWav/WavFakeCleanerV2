/**
 * i18n — EN/FR translations.
 */

const translations: Record<string, Record<string, string>> = {
  fr: {
    title: "Wav Fake Cleaner V2",
    subtitle: "Nettoyeur de faux followers Threads",
    lang_toggle: "EN",
    total: "Total",
    pending: "En attente",
    scanned: "Analysés",
    fakes: "Faux",
    removed: "Supprimés",
    to_review: "A vérifier",
    actions_today: "Actions/jour",
    actions_hour: "Actions/heure",
    errors: "Erreurs",
    slowdown: "Ralentissement",
    fetch: "Récupérer",
    scan: "Analyser",
    clean: "Supprimer",
    reset_scanned: "Réinitialiser",
    autopilot: "Autopilote",
    stop: "Arrêter",
    running: "En cours...",
    stopped: "Prêt",
    settings: "Paramètres",
    username: "Nom d'utilisateur",
    threshold: "Seuil de détection",
    safety: "Profil de vitesse",
    free: "Gratuit",
    prudent: "Prudent",
    normal: "Normal",
    aggressive: "Agressif",
    follower: "Follower",
    score: "Score",
    status: "Statut",
    breakdown: "Détails",
    filter_all: "Tous",
    filter_pending: "En attente",
    filter_ok: "OK",
    filter_review: "A vérifier",
    filter_fake: "Faux",
    filter_removed: "Supprimés",
    approve: "Approuver",
    reject: "Rejeter",
    approved: "Approuvé",
    no_data: "Aucune donnée",
    loading: "Chargement...",
    logs: "Activité",
    clear: "Effacer",
    no_logs: "En attente d'activité...",
    rate_limited: "Limité",
    daily_limit: "Limite/jour",
    hourly_limit: "Limite/heure",
    open_threads: "Ouvrir Threads",
    // Licence
    licence: "Licence",
    licence_active: "Licence active",
    licence_free: "Version gratuite",
    licence_activate: "Activer",
    licence_buy: "Passer au Max",
    licence_key_placeholder: "Clé de licence...",
    licence_invalid: "Clé invalide",
    licence_success: "Licence activée !",
    licence_desc: "Débloquez tous les profils de vitesse et les limites étendues.",
    licence_free_limits: "Gratuit : 200 analyses/jour, 50 suppressions/jour",
    licence_pro_limits: "Licence : limites étendues + profils Prudent/Normal/Agressif",
    // Settings extras
    pro_only: "Licence requise",
    save: "Enregistrer",
    saved: "Enregistré",
  },
  en: {
    title: "Wav Fake Cleaner V2",
    subtitle: "Threads fake follower cleaner",
    lang_toggle: "FR",
    total: "Total",
    pending: "Pending",
    scanned: "Scanned",
    fakes: "Fakes",
    removed: "Removed",
    to_review: "To review",
    actions_today: "Actions/day",
    actions_hour: "Actions/hour",
    errors: "Errors",
    slowdown: "Slowdown",
    fetch: "Fetch",
    scan: "Scan",
    clean: "Remove",
    reset_scanned: "Reset",
    autopilot: "Autopilot",
    stop: "Stop",
    running: "Running...",
    stopped: "Ready",
    settings: "Settings",
    username: "Username",
    threshold: "Detection threshold",
    safety: "Speed profile",
    free: "Free",
    prudent: "Prudent",
    normal: "Normal",
    aggressive: "Aggressive",
    follower: "Follower",
    score: "Score",
    status: "Status",
    breakdown: "Details",
    filter_all: "All",
    filter_pending: "Pending",
    filter_ok: "OK",
    filter_review: "To review",
    filter_fake: "Fake",
    filter_removed: "Removed",
    approve: "Approve",
    reject: "Reject",
    approved: "Approved",
    no_data: "No data",
    loading: "Loading...",
    logs: "Activity",
    clear: "Clear",
    no_logs: "Waiting for activity...",
    rate_limited: "Limited",
    daily_limit: "Limit/day",
    hourly_limit: "Limit/hour",
    open_threads: "Open Threads",
    // Licence
    licence: "License",
    licence_active: "License active",
    licence_free: "Free version",
    licence_activate: "Activate",
    licence_buy: "Go Max",
    licence_key_placeholder: "License key...",
    licence_invalid: "Invalid key",
    licence_success: "License activated!",
    licence_desc: "Unlock all speed profiles and extended limits.",
    licence_free_limits: "Free: 200 scans/day, 50 removals/day",
    licence_pro_limits: "License: extended limits + Prudent/Normal/Aggressive profiles",
    // Settings extras
    pro_only: "License required",
    save: "Save",
    saved: "Saved",
  },
};

export function getStoredLang(): string {
  try {
    return localStorage.getItem("wav_lang") || "fr";
  } catch {
    return "fr";
  }
}

export function setStoredLang(lang: string): void {
  try {
    localStorage.setItem("wav_lang", lang);
  } catch {
    // ignore
  }
}

export function t(key: string, lang: string): string {
  return translations[lang]?.[key] || translations.fr[key] || key;
}

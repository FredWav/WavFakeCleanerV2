const translations = {
  fr: {
    title: "Wav Fake Cleaner V2",
    subtitle: "Nettoyeur de faux followers Threads",
    lang_toggle: "EN",

    // Stats
    total: "Total",
    pending: "En attente",
    scanned: "Scannés",
    fakes: "Faux",
    removed: "Supprimés",
    actions_today: "Actions/jour",
    actions_hour: "Actions/heure",
    errors: "Erreurs",
    slowdown: "Ralentissement",

    // Controls
    fetch: "Récupérer",
    scan: "Scanner",
    clean: "Nettoyer",
    autopilot: "Autopilote",
    stop: "Arrêter",
    running: "En cours...",
    stopped: "Arrêté",

    // Settings
    settings: "Paramètres",
    username: "Nom d'utilisateur",
    threshold: "Seuil fake",
    safety: "Profil sécurité",
    prudent: "Prudent",
    normal: "Normal",
    aggressive: "Agressif",
    headless: "Mode headless",

    // Table
    follower: "Follower",
    score: "Score",
    status: "Statut",
    breakdown: "Détails",
    filter_all: "Tous",
    filter_pending: "En attente",
    filter_fake: "Faux",
    filter_removed: "Supprimés",
    no_data: "Aucune donnée",
    loading: "Chargement...",

    // Log
    logs: "Logs en direct",
    clear: "Effacer",
    no_logs: "En attente de logs...",

    // Rate
    rate_limited: "Limité",
    daily_limit: "Limite/jour",
    hourly_limit: "Limite/heure",
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
    actions_today: "Actions/day",
    actions_hour: "Actions/hour",
    errors: "Errors",
    slowdown: "Slowdown",

    fetch: "Fetch",
    scan: "Scan",
    clean: "Clean",
    autopilot: "Autopilot",
    stop: "Stop",
    running: "Running...",
    stopped: "Stopped",

    settings: "Settings",
    username: "Username",
    threshold: "Fake threshold",
    safety: "Safety profile",
    prudent: "Prudent",
    normal: "Normal",
    aggressive: "Aggressive",
    headless: "Headless mode",

    follower: "Follower",
    score: "Score",
    status: "Status",
    breakdown: "Details",
    filter_all: "All",
    filter_pending: "Pending",
    filter_fake: "Fake",
    filter_removed: "Removed",
    no_data: "No data",
    loading: "Loading...",

    logs: "Live logs",
    clear: "Clear",
    no_logs: "Waiting for logs...",

    rate_limited: "Limited",
    daily_limit: "Limit/day",
    hourly_limit: "Limit/hour",
  },
}

export function getStoredLang() {
  return localStorage.getItem("wav_lang") || "fr"
}

export function setStoredLang(lang) {
  localStorage.setItem("wav_lang", lang)
}

export function t(key, lang) {
  return translations[lang]?.[key] || translations.fr[key] || key
}

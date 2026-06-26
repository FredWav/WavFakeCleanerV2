// ── CSS selectors for Threads.net ──
// Ported from backend/engine/selectors.yaml
// These must be updated when Threads changes its DOM.

export const SELECTORS = {
  profile: {
    loadedCheck: "header,main,h1,[data-pressable-container]",
    followersLink: "a[href*='followers']",
    followersTextPattern: /^\d[\d,.\s\u00a0\u202fKkMm]*\s*(followers?|abonn[eé]s?|seguidor(?:es)?|abonnent(?:en)?|volgers?|フォロワー|粉丝|追蹤者)$/iu,
    profilePic: "img",
    repliesTabTexts: ["Réponses", "Replies", "réponses", "replies", "Respuestas", "Respostas", "Antworten", "Risposte", "Antwoorden", "返信"],
    threadsTabTexts: ["Threads", "threads", "スレッド"],
    mediaTabTexts: ["Médias", "Media", "médias", "media", "Medios", "Mídia", "Medien", "メディア"],
    // Bouton « Débloquer » : présent UNIQUEMENT sur le profil d'un compte que TU
    // as bloqué (Threads masque alors le contenu → « Contenu indisponible »).
    // Sert à ne PAS scorer un compte bloqué comme un faux : il est déjà traité.
    unblockButtonTexts: ["Débloquer", "Unblock", "Desbloquear", "Entsperren", "Sblocca", "Deblokkeren", "ブロックを解除", "解除拦截"],
    noMediaPatterns: [
      /aucun m[ée]dia/i,
      /no media yet/i,
      /nothing here yet/i,
      /hasn.t posted.*media/i,
    ],
    noReplyPatterns: [
      /no replies yet/i,
      /pas encore de r[ée]ponse/i,
      /aucune r[ée]ponse/i,
      /nothing here yet/i,
      /rien pour l.instant/i,
      /hasn.t replied/i,
      /n.a pas encore r[ée]pondu/i,
    ],
    noThreadsPatterns: [
      /aucun thread/i,
      /no threads yet/i,
      /nothing here yet/i,
      /hasn.t posted/i,
      /n.a pas encore publi/i,
    ],
    notFoundPatterns: [
      /not found/i,
      /not available/i,
      /n'est pas disponible/i,
      /page isn.t available/i,
      /page introuvable/i,
    ],
    // Phrases displayed in Threads' private-profile banner. We try to match
    // both common wordings per locale. Strict-ish to limit false positives
    // from user-generated bios containing the word "private".
    privatePatterns: [
      // EN — Threads affiche maintenant « This profile is private » (anciennes versions : « account »)
      /this account is private/i,
      /this is a private account/i,
      /account is private/i,
      /this profile is private/i,
      /profile is private/i,
      // FR — Threads affiche "Ce profil est privé." (et non plus "compte")
      /ce compte est priv/i,
      /cette page est priv/i,
      /profil priv/i,
      /profil est priv/i,
      /compte priv[ée]/i,
      // ES — « Este perfil es privado »
      /esta cuenta es privada/i,
      /cuenta privada/i,
      /perfil es privado/i,
      /perfil privado/i,
      // PT — « Este perfil é privado »
      /esta conta [eé] privada/i,
      /conta privada/i,
      /perfil [eé] privado/i,
      /perfil privado/i,
      // DE
      /dieses konto ist privat/i,
      /privates konto/i,
      // IT
      /questo account [eè] privato/i,
      /account privato/i,
      // NL
      /dit account is priv[ée]/i,
      /priv[ée] account/i,
      // JP / ZH
      /非公開アカウント/,
      /このアカウントは非公開/,
      /此[帳账]户不公开/,
      /私人[帳账]户/,
    ],
  },

  scroll: {
    // Primary: classic modal with role="dialog"
    dialogLinks: 'div[role="dialog"] a[href*="/@"]',
    // Modern variant: aria-modal wrapper without role="dialog"
    modalLinks: '[aria-modal="true"] a[href*="/@"]',
    // Test-id variant seen on some rollouts
    testIdLinks: '[data-testid*="followers" i] a[href*="/@"], [data-testid*="follower-list" i] a[href*="/@"]',
    // Fallback: all profile links on the page (filtered by regex afterwards)
    profileLinks: 'a[href*="/@"]',
    // Marker attribute set on the chosen scroll container
    scrollableAttr: "data-autoscroll",
    // URL pattern for the dedicated followers page (Threads sometimes routes there
    // instead of opening a modal)
    followersUrlPattern: /\/@[\w.]+\/followers\/?$/,
  },

  menu: {
    removePatterns: [
      /supprimer.*follower/i,
      /remove.*follower/i,
      /supprimer.*abonn/i,
      /retirer.*abonn/i,
      /retirer.*follower/i,
      /remove.*follow/i,
      /eliminar.*seguidor/i,   // ES
      /remover.*seguidor/i,    // PT
      /follower.*entfernen/i,  // DE
      /rimuovi.*follower/i,    // IT
      /volger.*verwijderen/i,  // NL
    ],
    blockPatterns: [/^bloquer$/i, /^block$/i, /^bloquear$/i, /^blockieren$/i, /^blocca$/i, /^blokkeren$/i],
    confirmPatterns: [
      /^supprimer$/i,
      /^remove$/i,
      /^bloquer$/i,
      /^block$/i,
      /confirm/i,
      /^oui$/i,
      /^yes$/i,
    ],
    menuItems: [
      "supprimer follower",
      "remove follower",
      "bloquer",
      "block",
      "restreindre",
      "restrict",
      "signaler",
      "report",
      "mettre en sourdine",
      "mute",
      "copier le lien",
      "copy link",
    ],
    chromeJunk: new Set([
      "ajouter comme colonne",
      "add as column",
      "épingler l'onglet",
      "pin tab",
      "fermer l'onglet",
    ]),
  },

  spam: {
    keywords: [
      /whatsapp/i,
      /telegram/i,
      /signal/i,
      /envie de faire connaissance/i,
      /click.*link.*bio/i,
      /dm.*for.*promo/i,
      /follow.*for.*follow/i,
      /check.*my.*profile/i,
    ],
    phonePatterns: [/\b0\d{9,}\b/, /\+\d{10,}/],
  },
};

// ── 429 detection ──
// Locale-aware: Threads localizes the rate-limit interstitial. We accept
// either the literal "429" + a "page not working"-style sentence, OR the
// universal "too many requests" phrase regardless of locale.

const PAGE_NOT_WORKING_SNIPPETS = [
  "cette page ne fonctionne pas",     // FR
  "this page isn't working",          // EN
  "esta página no funciona",          // ES
  "esta pagina nao funciona",         // PT (no diacritics — scrap might strip)
  "esta página não funciona",         // PT
  "diese seite funktioniert nicht",   // DE
  "questa pagina non funziona",       // IT
  "deze pagina werkt niet",           // NL
];

const TOO_MANY_REQUESTS_SNIPPETS = [
  "too many requests",                // EN
  "trop de requêtes",                 // FR
  "demasiadas solicitudes",           // ES
  "demasiadas solicitações",          // PT
  "zu viele anfragen",                // DE
  "troppe richieste",                 // IT
  "te veel verzoeken",                // NL
];

export function is429(body: string): boolean {
  const lo = body.toLowerCase();
  if (TOO_MANY_REQUESTS_SNIPPETS.some((s) => lo.includes(s))) return true;
  if (body.includes("429") && PAGE_NOT_WORKING_SNIPPETS.some((s) => lo.includes(s))) return true;
  return false;
}

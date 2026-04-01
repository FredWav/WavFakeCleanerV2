// ── CSS selectors for Threads.net ──
// Ported from backend/engine/selectors.yaml
// These must be updated when Threads changes its DOM.

export const SELECTORS = {
  profile: {
    loadedCheck: "header,main,h1,[data-pressable-container]",
    followersLink: "a[href*='followers']",
    followersTextPattern: /^\d[\d,.\s\u00a0\u202fKkMm]*\s*(followers|abonnés)$/i,
    profilePic: "img",
    repliesTabTexts: ["Réponses", "Replies", "réponses", "replies"],
    threadsTabTexts: ["Threads", "threads"],
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
    privatePatterns: [
      /account is private/i,
      /compte est priv/i,
      /profil priv/i,
    ],
  },

  scroll: {
    dialogLinks: 'div[role="dialog"] a[href*="/@"]',
    profileLinks: 'a[href*="/@"]',
    scrollableAttr: "data-autoscroll",
  },

  menu: {
    removePatterns: [
      /supprimer follower/i,
      /remove follower/i,
      /supprimer l.abonn/i,
      /retirer.*abonn/i,
      /remove.*follow/i,
    ],
    blockPatterns: [/^bloquer$/i, /^block$/i],
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

export function is429(body: string): boolean {
  const lo = body.toLowerCase();
  return (
    (body.includes("429") &&
      (lo.includes("cette page ne fonctionne pas") ||
        lo.includes("this page isn't working"))) ||
    lo.includes("too many requests")
  );
}

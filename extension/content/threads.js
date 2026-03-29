/**
 * Content Script — injected into threads.net pages.
 *
 * Handles all DOM interaction:
 * - Profile data extraction (follower count, bio, pic, posts, replies)
 * - Follower list fetching (API + scroll fallback)
 * - Follower removal (three dots → remove → confirm)
 * - Human navigation simulation
 */

// ── Message handler ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg).then(sendResponse).catch(e => {
    sendResponse({ error: e.message });
  });
  return true;
});

async function handleMessage(msg) {
  switch (msg.action) {
    case "fetch_followers":
      return await fetchFollowers();
    case "extract_profile":
      return await extractProfile(msg.username);
    case "remove_follower":
      return await removeFollower(msg.username);
    case "human_navigation":
      return await humanNavigation();
    default:
      return { error: `Unknown content action: ${msg.action}` };
  }
}

// ── Follower fetching ───────────────────────────────────────────────────────

async function fetchFollowers() {
  const username = getCurrentUsername();
  if (!username) return { error: "Not on a profile page" };

  // Try API first
  const userId = await resolveUserId(username);
  if (userId) {
    const followers = await fetchFollowersViaApi(userId, username);
    if (followers && followers.length > 0) {
      return { followers };
    }
  }

  // Fallback: scroll-based
  return { error: "API fetch not available, use profile page" };
}

async function resolveUserId(username) {
  const csrf = getCsrf();
  const headers = {
    "X-IG-App-ID": "238260118697367",
    Accept: "application/json",
    "X-Requested-With": "XMLHttpRequest",
  };
  if (csrf) headers["X-CSRFToken"] = csrf;

  const endpoints = [
    `https://www.threads.net/api/v1/users/web_profile_info/?username=${username}`,
    `https://www.threads.net/api/v1/users/search/?q=${username}`,
  ];

  for (const url of endpoints) {
    try {
      const r = await fetch(url, { credentials: "include", headers });
      if (!r.ok) continue;
      const j = await r.json();
      const uid = j?.data?.user?.id || j?.data?.user?.pk
        || j?.user?.pk || j?.user?.id;
      if (uid) return String(uid);
      const users = j?.users || [];
      const match = users.find(u => u.username === username);
      if (match) return String(match.pk || match.id);
    } catch { /* continue */ }
  }
  return null;
}

async function fetchFollowersViaApi(userId, myUsername) {
  const csrf = getCsrf();
  const headers = {
    "X-IG-App-ID": "238260118697367",
    Accept: "application/json",
    "X-Requested-With": "XMLHttpRequest",
  };
  if (csrf) headers["X-CSRFToken"] = csrf;

  const collected = [];
  let maxId = null;
  let page = 0;

  while (true) {
    page++;
    let url = `https://www.threads.net/api/v1/friendships/${userId}/followers/?count=50&search_surface=follow_list_page`;
    if (maxId) url += `&max_id=${maxId}`;

    try {
      const r = await fetch(url, { credentials: "include", headers });
      if (r.status === 429) {
        await delay(60000 + Math.random() * 60000);
        continue;
      }
      if (!r.ok) break;

      const data = await r.json();
      const users = data.users || [];
      if (!users.length) break;

      for (const u of users) {
        const pseudo = (u.username || "").trim();
        if (pseudo && pseudo !== myUsername) {
          collected.push({
            username: pseudo,
            fullName: (u.full_name || "").trim(),
            followerCount: u.follower_count ?? null,
            isPrivate: !!u.is_private,
            hasProfilePic: !isDefaultPic(u.profile_pic_url || ""),
          });
        }
      }

      maxId = data.next_max_id;
      if (!maxId) break;

      await delay(800 + Math.random() * 700 + page * 20);
    } catch {
      break;
    }
  }

  return collected;
}

// ── Profile extraction ──────────────────────────────────────────────────────

async function extractProfile(username) {
  // Navigate to profile
  const url = `https://www.threads.net/@${username}`;
  if (!location.href.includes(`/@${username}`)) {
    location.href = url;
    await waitForNavigation(8000);
  }

  await delay(500 + Math.random() * 500);

  const bodyText = document.body?.innerText || "";

  // Check 429
  if (bodyText.length < 500 && is429(bodyText)) {
    return { error: "429", notFound: true };
  }

  // Check not found
  if (/not found|not available|n'est pas disponible|page isn.t available|page introuvable/i.test(bodyText)) {
    return { username, notFound: true };
  }

  const isPrivate = /account is private|compte est priv[ée]|profil priv/i.test(bodyText);

  // Extract profile info
  const info = extractProfileInfo(username);
  if (!isPrivate && info.looksPrivate) info.isPrivate = true;

  // Count posts (public only)
  let postCount = 0;
  let allPostsRecent = false;
  let duplicateRatio = 0;
  let hasSpamKeywords = false;
  let hasReplies = false;

  if (!isPrivate && !info.looksPrivate) {
    const threadsEmpty = /aucun thread|no threads yet|nothing here yet|hasn.t posted|n.a pas encore publi/i.test(bodyText);
    if (threadsEmpty) {
      postCount = 0;
    } else {
      const postInfo = countPosts();
      postCount = postInfo.count;
      allPostsRecent = postInfo.allRecent;
      duplicateRatio = postInfo.duplicateRatio;
      hasSpamKeywords = postInfo.hasSpamKeywords;
    }

    // Check replies tab
    hasReplies = await checkReplies(username);
  }

  return {
    username,
    notFound: false,
    isPrivate: isPrivate || info.looksPrivate,
    isVerified: info.isVerified,
    followerCount: info.followerCount,
    postCount,
    hasBio: info.hasBio,
    hasReplies,
    hasRealPic: info.hasRealPic,
    hasFullName: info.hasFullName,
    hasIgLink: info.hasIgLink,
    hasLinkInBio: info.hasLinkInBio,
    fullName: info.fullName,
    allPostsRecent,
    duplicateRatio,
    hasSpamKeywords,
  };
}

function extractProfileInfo(username) {
  const result = {
    followerCount: null, hasRealPic: false, hasFullName: false,
    hasIgLink: false, hasBio: false, isVerified: false,
    fullName: "", hasLinkInBio: false, looksPrivate: false,
  };

  // Follower count
  try {
    for (const el of document.querySelectorAll("span, a, div, p")) {
      if (el.children.length > 3) continue;
      const t = (el.textContent || "").trim();
      const m = t.match(/^([\d][\d,. \u00a0\u202f]*[KkMm]?)\s*(followers|abonnés)$/i);
      if (m) {
        let cleaned = m[1].trim().replace(/[\s\u00a0\u202f]/g, "");
        const suffix = cleaned.slice(-1).toUpperCase();
        if (suffix === "K") result.followerCount = Math.round(parseFloat(cleaned.slice(0, -1).replace(",", ".")) * 1000);
        else if (suffix === "M") result.followerCount = Math.round(parseFloat(cleaned.slice(0, -1).replace(",", ".")) * 1000000);
        else result.followerCount = parseInt(cleaned.replace(/[^\d]/g, ""), 10) || 0;
        break;
      }
    }
  } catch { /* ok */ }

  // Profile picture
  try {
    for (const img of document.querySelectorAll("img")) {
      const src = img.src || "";
      const alt = (img.alt || "").toLowerCase();
      const w = img.naturalWidth || img.width || 0;
      if ((alt.includes("photo") || alt.includes("profile") || alt.includes("avatar") || alt.includes(username.toLowerCase())) && w >= 40) {
        result.hasRealPic = !isDefaultPic(src);
        break;
      }
    }
  } catch { /* ok */ }

  // Full name
  try {
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle) {
      const m = (ogTitle.content || "").match(/^(.+?)\s*\(@/);
      if (m) {
        result.fullName = m[1].trim();
        result.hasFullName = result.fullName.length >= 3 && result.fullName !== username;
      }
    }
  } catch { /* ok */ }

  // Instagram link
  try { result.hasIgLink = !!document.querySelector('a[href*="instagram.com"]'); } catch { /* ok */ }

  // Bio
  try {
    const metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc) {
      let bio = metaDesc.content || "";
      bio = bio.replace(/[\d,.\s]*\s*(followers?|abonnés|following|replies).*/gi, "").trim();
      bio = bio.replace(/^.*?-\s*/, "").trim();
      result.hasBio = bio.length >= 5;
    }
  } catch { /* ok */ }

  // Link in bio
  try {
    for (const a of document.querySelectorAll("a[href]")) {
      const href = (a.href || "").toLowerCase();
      const text = (a.textContent || "").trim();
      if (href.includes("threads.net") || href.includes("instagram.com") || href.includes("javascript:") || href === "#") continue;
      if ((href.startsWith("http://") || href.startsWith("https://")) && text.length > 3 && a.offsetHeight > 0) {
        const r = a.getBoundingClientRect();
        if (r.top < 600) { result.hasLinkInBio = true; break; }
      }
    }
  } catch { /* ok */ }

  // Private detection (heuristic)
  try {
    const articles = document.querySelectorAll("article, [data-pressable-container]");
    const tabs = document.querySelectorAll('[role="tab"], [role="tablist"]');
    const bodyText = (document.body?.innerText || "").toLowerCase();
    const hasPrivateText = /account is private|compte est priv|profil priv/.test(bodyText);
    const hasNoContent = articles.length === 0
      && !bodyText.includes("aucun thread") && !bodyText.includes("no threads yet")
      && !bodyText.includes("hasn't posted") && !bodyText.includes("n'a pas encore publi");
    if (hasPrivateText || (hasNoContent && tabs.length === 0 && result.followerCount !== null)) {
      result.looksPrivate = true;
    }
  } catch { /* ok */ }

  // Verified
  try {
    result.isVerified = !!document.querySelector('[data-testid="verified-badge"], svg[aria-label*="Verified"], svg[aria-label*="vérifié"]');
  } catch { /* ok */ }

  return result;
}

function countPosts() {
  const articles = document.querySelectorAll("article");
  let count = 0;
  for (const a of articles) {
    if (!a.closest("article")?.closest("article") || a.closest("article") === a) count++;
  }
  if (count === 0) count = document.querySelectorAll("[data-pressable-container]").length;

  // Recent check
  const times = document.querySelectorAll("time[datetime]");
  let allRecent = times.length > 0;
  const now = Date.now();
  for (const t of times) {
    const dt = new Date(t.getAttribute("datetime"));
    if (!isNaN(dt.getTime()) && (now - dt.getTime()) > 72 * 3600 * 1000) allRecent = false;
  }

  // Duplicates
  let duplicateRatio = 0;
  if (articles.length >= 2) {
    const texts = [...articles].map(a => (a.innerText || "").trim().substring(0, 120).toLowerCase()).filter(t => t.length > 20);
    if (texts.length >= 2) {
      const ref = texts[0];
      let dupes = 0;
      for (let i = 1; i < texts.length; i++) {
        let shared = 0;
        const minLen = Math.min(ref.length, texts[i].length);
        for (let j = 0; j < minLen; j++) if (ref[j] === texts[i][j]) shared++;
        if (shared / minLen > 0.6) dupes++;
      }
      duplicateRatio = dupes / (texts.length - 1);
    }
  }

  // Spam keywords
  const body = (document.body?.innerText || "").toLowerCase();
  const spamPatterns = [/whatsapp|telegram|signal/, /\b0\d{9,}\b/, /\+\d{10,}/, /follow.*for.*follow/i, /dm.*for.*promo/i];
  const hasSpamKeywords = spamPatterns.some(p => p.test(body));

  return { count, allRecent: allRecent && count > 0, duplicateRatio, hasSpamKeywords };
}

async function checkReplies(username) {
  // Click replies tab
  for (const text of ["Réponses", "Replies", "réponses", "replies"]) {
    try {
      const els = [...document.querySelectorAll('[role="tab"], [role="tablist"] > *, a, div')];
      const tab = els.find(el => (el.textContent || "").trim().toLowerCase() === text.toLowerCase());
      if (tab) { tab.click(); break; }
    } catch { /* continue */ }
  }

  await delay(2000);

  const body = document.body?.innerText || "";
  if (/aucune r[ée]ponse|no replies yet|nothing here yet|hasn.t replied/i.test(body)) return false;
  if (document.querySelectorAll("article, [data-pressable-container]").length > 0) return true;
  if (document.querySelectorAll("time[datetime]").length > 0) return true;
  return false;
}

// ── Follower removal ────────────────────────────────────────────────────────

async function removeFollower(username) {
  // Navigate to profile
  const url = `https://www.threads.net/@${username}`;
  location.href = url;
  await waitForNavigation(10000);
  await delay(1500 + Math.random() * 1000);

  // Check 429
  const body = document.body?.innerText || "";
  if (is429(body)) return { error: "429" };

  // Click three dots menu
  const dotsBtn = document.querySelector('[aria-label="More"], [aria-label="Plus"]')
    || [...document.querySelectorAll('div[role="button"], button')].find(b => {
      const t = (b.textContent || "").trim();
      return t === "⋯" || t === "..." || b.querySelector("svg");
    });
  if (!dotsBtn) return { error: "dots_not_found" };
  dotsBtn.click();
  await delay(700 + Math.random() * 300);

  // Click remove/block option
  const menuItems = [...document.querySelectorAll('[role="menuitem"], [role="button"], button, div')];
  const removeBtn = menuItems.find(el => {
    const t = (el.textContent || "").toLowerCase();
    return t.includes("retirer") || t.includes("remove") || t.includes("supprimer")
      || t.includes("bloquer") || t.includes("block");
  });
  if (!removeBtn) {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    return { error: "remove_not_found" };
  }
  removeBtn.click();
  await delay(700 + Math.random() * 300);

  // Confirm
  const confirmBtns = [...document.querySelectorAll('button, div[role="button"]')];
  const confirm = confirmBtns.find(el => {
    const t = (el.textContent || "").toLowerCase();
    return t.includes("confirmer") || t.includes("confirm") || t.includes("retirer") || t.includes("remove");
  });
  if (confirm) confirm.click();
  await delay(500);

  return { ok: true };
}

// ── Human navigation ────────────────────────────────────────────────────────

async function humanNavigation() {
  const destinations = [
    "https://www.threads.net/",
    "https://www.threads.net/search",
  ];
  const url = destinations[Math.floor(Math.random() * destinations.length)];
  location.href = url;
  await delay(2000 + Math.random() * 3000);
  window.scrollBy(0, 200 + Math.random() * 600);
  await delay(1000 + Math.random() * 2000);
  return { ok: true };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function getCurrentUsername() {
  const m = location.pathname.match(/^\/@([\w.]+)/);
  return m ? m[1] : null;
}

function getCsrf() {
  return (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || "";
}

function isDefaultPic(url) {
  if (!url) return true;
  return ["default", "empty", "placeholder", "/44884218_345"].some(x => url.includes(x));
}

function is429(body) {
  const lo = body.toLowerCase();
  return ("429" in body && ("cette page ne fonctionne pas" in lo || "this page isn't working" in lo))
    || lo.includes("too many requests");
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function waitForNavigation(timeout = 8000) {
  return new Promise(resolve => {
    const done = () => { clearTimeout(t); resolve(); };
    const t = setTimeout(done, timeout);
    window.addEventListener("load", done, { once: true });
  });
}

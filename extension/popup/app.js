/**
 * Popup App — main controller for the extension popup UI.
 * Communicates with service-worker via chrome.runtime.sendMessage.
 */

// ── State ───────────────────────────────────────────────────────────────────

let state = {
  status: "idle",        // idle | fetching | scanning | cleaning | autopilot | paused | error
  statusText: "Pret",
  followers: [],
  stats: { total: 0, scanned: 0, fake: 0, removed: 0, to_review: 0, ok: 0 },
  plan: "free",
  email: null,
  removalsToday: 0,
  removalsLeft: 50,
  settings: {
    threshold: 60,
    safety: "balanced",
    humanNav: true,
    autoReview: false,
  },
};

let currentFilter = "all";

// ── Init ────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  setupTabNavigation();
  setupAuthToggle();
  setupActions();
  setupFilters();
  setupSettings();
  await loadState();
  render();
});

// Listen for state broadcasts from service worker
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === "state_update" && msg.state) {
    state.status = msg.state.phase || state.status;
    state.stats = {
      total: msg.state.counts?.total || 0,
      scanned: msg.state.counts?.scanned || 0,
      fake: msg.state.counts?.fakes || 0,
      removed: msg.state.counts?.removed || 0,
      to_review: msg.state.counts?.toReview || 0,
      ok: msg.state.counts?.ok || 0,
    };
    state.plan = msg.state.plan || state.plan;
    state.removalsToday = msg.state.removalsToday || 0;
    state.settings = msg.state.settings || state.settings;
    render();
  }
});

// ── Communication with Service Worker ───────────────────────────────────────

function send(action, data = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action, ...data }, (response) => {
      resolve(response);
    });
  });
}

async function loadState() {
  const res = await send("get_state");
  if (res && !res.error) {
    state.status = res.phase || "idle";
    state.statusText = res.running ? "En cours..." : "Pret";
    state.plan = res.plan || "free";
    state.removalsToday = res.removalsToday || 0;
    state.settings = res.settings || state.settings;
    if (res.counts) {
      state.stats = {
        total: res.counts.total || 0,
        scanned: res.counts.scanned || 0,
        fake: res.counts.fakes || 0,
        removed: res.counts.removed || 0,
        to_review: res.counts.toReview || 0,
        ok: res.counts.ok || 0,
      };
    }
  }
  // Load auth state
  const auth = await send("get_auth");
  if (auth && !auth.error) {
    state.email = auth.email || null;
    state.plan = auth.plan || "free";
  }
  // Load followers
  const followers = await send("get_followers", { filter: "all", limit: 500 });
  if (Array.isArray(followers)) {
    state.followers = followers;
  }
}

// ── Tab Navigation ──────────────────────────────────────────────────────────

function setupTabNavigation() {
  document.querySelectorAll("#nav-tabs .tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll("#nav-tabs .tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById(`panel-${tab.dataset.tab}`).classList.add("active");
    });
  });
}

// ── Auth Toggle (Login / Register) ──────────────────────────────────────────

function setupAuthToggle() {
  document.querySelectorAll(".auth-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".auth-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");

      const isLogin = tab.dataset.auth === "login";
      document.getElementById("form-login").classList.toggle("hidden", !isLogin);
      document.getElementById("form-register").classList.toggle("hidden", isLogin);
      hideAuthError();
    });
  });

  // Login form
  document.getElementById("form-login").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = document.getElementById("login-email").value;
    const password = document.getElementById("login-password").value;
    const res = await send("login", { email, password });
    if (res?.error) {
      showAuthError(res.error);
    } else {
      state.email = email;
      state.plan = res?.plan || "free";
      render();
    }
  });

  // Register form
  document.getElementById("form-register").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = document.getElementById("reg-email").value;
    const password = document.getElementById("reg-password").value;
    const password2 = document.getElementById("reg-password2").value;
    const promoConsent = document.getElementById("reg-promo-consent").checked;

    if (password !== password2) {
      showAuthError("Les mots de passe ne correspondent pas");
      return;
    }

    const res = await send("register", { email, password, promo_consent: promoConsent });
    if (res?.error) {
      showAuthError(res.error);
    } else {
      state.email = email;
      state.plan = "free";
      render();
    }
  });

  // Logout
  document.getElementById("btn-logout").addEventListener("click", async () => {
    await send("logout");
    state.email = null;
    state.plan = "free";
    render();
  });

  // Upgrade
  document.getElementById("btn-upgrade").addEventListener("click", async () => {
    const res = await send("upgrade");
    if (res?.url) {
      chrome.tabs.create({ url: res.url });
    }
  });
}

// ── Action Buttons ──────────────────────────────────────────────────────────

function setupActions() {
  document.getElementById("btn-fetch").addEventListener("click", async () => {
    setStatus("running", "Recuperation des followers...");
    disableActions(true);
    await send("start_fetch");
  });

  document.getElementById("btn-scan").addEventListener("click", async () => {
    setStatus("running", "Scan en cours...");
    disableActions(true);
    await send("start_scan");
  });

  document.getElementById("btn-clean").addEventListener("click", async () => {
    setStatus("running", "Nettoyage en cours...");
    disableActions(true);
    await send("start_clean");
  });

  document.getElementById("btn-autopilot").addEventListener("click", async () => {
    setStatus("running", "Autopilot actif...");
    disableActions(true);
    await send("start_autopilot");
  });

  document.getElementById("btn-stop").addEventListener("click", async () => {
    await send("stop");
    setStatus("idle", "Arrete");
    disableActions(false);
  });
}

// ── Follower Filters ────────────────────────────────────────────────────────

function setupFilters() {
  document.querySelectorAll(".ftab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".ftab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      currentFilter = tab.dataset.filter;
      renderFollowers();
    });
  });
}

// ── Settings ────────────────────────────────────────────────────────────────

function setupSettings() {
  const thresholdInput = document.getElementById("setting-threshold");
  const thresholdValue = document.getElementById("threshold-value");

  thresholdInput.addEventListener("input", () => {
    thresholdValue.textContent = thresholdInput.value;
  });
  thresholdInput.addEventListener("change", () => {
    state.settings.threshold = parseInt(thresholdInput.value);
    saveSettings();
  });

  document.getElementById("setting-safety").addEventListener("change", (e) => {
    state.settings.safety = e.target.value;
    saveSettings();
  });

  document.getElementById("setting-human-nav").addEventListener("change", (e) => {
    state.settings.humanNav = e.target.checked;
    saveSettings();
  });

  document.getElementById("setting-auto-review").addEventListener("change", (e) => {
    state.settings.autoReview = e.target.checked;
    saveSettings();
  });

  document.getElementById("btn-reset-settings").addEventListener("click", () => {
    state.settings = { threshold: 60, safety: "balanced", humanNav: true, autoReview: false };
    saveSettings();
    renderSettings();
  });
}

async function saveSettings() {
  await send("updateSettings", { settings: state.settings });
}

// ── Render ──────────────────────────────────────────────────────────────────

function render() {
  renderStats();
  renderQuota();
  renderStatus();
  renderAuth();
  renderSettings();
  renderFollowers();
  renderPlanBadge();
}

function renderStats() {
  const s = state.stats;
  document.getElementById("stat-total").textContent = s.total || "—";
  document.getElementById("stat-fake").textContent = s.fake || "—";
  document.getElementById("stat-review").textContent = s.to_review || "—";
  document.getElementById("stat-ok").textContent = s.ok || "—";
  document.getElementById("stat-removed").textContent = s.removed || "—";
  document.getElementById("stat-scanned").textContent = s.scanned || "—";
}

function renderQuota() {
  const wrap = document.getElementById("quota-bar-wrap");
  if (state.plan === "pro") {
    wrap.classList.add("hidden");
    return;
  }
  wrap.classList.remove("hidden");
  const used = state.removalsToday || 0;
  const max = 50;
  document.getElementById("quota-used").textContent = used;
  document.getElementById("quota-fill").style.width = `${Math.min(100, (used / max) * 100)}%`;
}

function renderStatus() {
  const icon = document.getElementById("status-icon");
  const text = document.getElementById("status-text");

  icon.className = "status-dot";
  const running = ["fetching", "scanning", "cleaning", "autopilot"].includes(state.status);
  if (running) icon.classList.add("running");
  else if (state.status === "error") icon.classList.add("error");
  else if (state.status === "paused") icon.classList.add("paused");
  else icon.classList.add("idle");

  text.textContent = state.statusText || state.status;

  // Enable/disable stop button
  document.getElementById("btn-stop").disabled = !running;
  disableActions(running);
}

function renderAuth() {
  const loggedOut = document.getElementById("auth-logged-out");
  const loggedIn = document.getElementById("auth-logged-in");

  if (state.email) {
    loggedOut.classList.add("hidden");
    loggedIn.classList.remove("hidden");
    document.getElementById("profile-email").textContent = state.email;
    document.getElementById("profile-plan").textContent = state.plan === "pro" ? "Pro" : "Free";
    document.getElementById("upgrade-section").classList.toggle("hidden", state.plan === "pro");
  } else {
    loggedOut.classList.remove("hidden");
    loggedIn.classList.add("hidden");
  }
}

function renderSettings() {
  document.getElementById("setting-threshold").value = state.settings.threshold;
  document.getElementById("threshold-value").textContent = state.settings.threshold;
  document.getElementById("setting-safety").value = state.settings.safety;
  document.getElementById("setting-human-nav").checked = state.settings.humanNav;
  document.getElementById("setting-auto-review").checked = state.settings.autoReview;
}

function renderPlanBadge() {
  const badge = document.getElementById("plan-badge");
  if (state.plan === "pro") {
    badge.textContent = "PRO";
    badge.className = "badge badge-pro";
  } else {
    badge.textContent = "FREE";
    badge.className = "badge badge-free";
  }
}

function renderFollowers() {
  const section = document.getElementById("follower-section");
  const list = document.getElementById("follower-list");
  const empty = document.getElementById("follower-empty");

  if (!state.followers || state.followers.length === 0) {
    section.classList.add("hidden");
    return;
  }

  section.classList.remove("hidden");
  const filtered = filterFollowers(state.followers, currentFilter);

  if (filtered.length === 0) {
    list.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }

  empty.classList.add("hidden");
  list.innerHTML = filtered.map(f => renderFollowerRow(f)).join("");

  // Attach review action handlers
  list.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const username = btn.dataset.username;
      const action = btn.dataset.action;
      await send(action, { username });
    });
  });
}

function filterFollowers(followers, filter) {
  const threshold = state.settings.threshold;
  switch (filter) {
    case "fake":
      return followers.filter(f => f.score >= threshold && f.status !== "removed");
    case "review":
      return followers.filter(f => f.status === "to_review");
    case "ok":
      return followers.filter(f => f.score !== null && f.score !== undefined && f.score >= 0 && f.score < threshold && f.status !== "removed" && f.status !== "to_review");
    case "removed":
      return followers.filter(f => f.status === "removed");
    default:
      return followers;
  }
}

function renderFollowerRow(f) {
  const scoreClass = f.score >= 60 ? "score-high" : f.score >= 30 ? "score-mid" : "score-low";
  const scoreText = f.score !== null && f.score !== undefined && f.score >= 0 ? f.score : "—";
  const profileUrl = `https://www.threads.net/@${encodeURIComponent(f.username)}`;

  let actions = "";
  if (f.status === "to_review") {
    actions = `
      <div class="follower-actions">
        <button class="btn-sm btn-approve" data-action="approve" data-username="${f.username}">OK</button>
        <button class="btn-sm btn-reject" data-action="reject" data-username="${f.username}">Faux</button>
      </div>`;
  }

  return `
    <div class="follower-row">
      <a href="${profileUrl}" target="_blank" class="follower-name" title="@${f.username}">@${f.username}</a>
      <span class="follower-score ${scoreClass}">${scoreText}</span>
      ${f.status ? `<span class="follower-status">${f.status}</span>` : ""}
      ${actions}
    </div>`;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function setStatus(status, text) {
  state.status = status;
  state.statusText = text;
  renderStatus();
}

function disableActions(disabled) {
  ["btn-fetch", "btn-scan", "btn-clean", "btn-autopilot"].forEach((id) => {
    document.getElementById(id).disabled = disabled;
  });
  document.getElementById("btn-stop").disabled = !disabled;
}

function showAuthError(msg) {
  const el = document.getElementById("auth-error");
  el.textContent = msg;
  el.classList.remove("hidden");
}

function hideAuthError() {
  document.getElementById("auth-error").classList.add("hidden");
}

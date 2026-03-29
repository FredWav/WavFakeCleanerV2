/**
 * QuotaManager — tracks daily usage and checks limits against backend.
 *
 * Free: 50 removals/day
 * Pro:  unlimited
 */

const API_BASE = "https://api.wavfakecleaner.com";

const PLANS = {
  free: { removals_per_day: 50, scan_per_day: Infinity },
  pro:  { removals_per_day: Infinity, scan_per_day: Infinity },
};

export class QuotaManager {
  constructor() {
    this._plan = "free";
    this._dailyRemovals = 0;
    this._dailyDate = "";
    this._token = null;
  }

  async init() {
    const stored = await chrome.storage.local.get([
      "wav_plan", "wav_daily_removals", "wav_daily_date", "wav_token",
    ]);
    this._plan = stored.wav_plan || "free";
    this._dailyRemovals = stored.wav_daily_removals || 0;
    this._dailyDate = stored.wav_daily_date || "";
    this._token = stored.wav_token || null;
    this._rotateDay();
  }

  get plan() { return this._plan; }
  get isPro() { return this._plan === "pro"; }
  get removalsToday() { return this._dailyRemovals; }
  get removalsLeft() {
    const limit = PLANS[this._plan].removals_per_day;
    if (limit === Infinity) return Infinity;
    return Math.max(0, limit - this._dailyRemovals);
  }

  canRemove() {
    this._rotateDay();
    return this.removalsLeft > 0;
  }

  async recordRemoval() {
    this._rotateDay();
    this._dailyRemovals++;
    await this._save();
    // Report to backend (fire & forget)
    this._reportUsage("removal").catch(() => {});
  }

  async setToken(token) {
    this._token = token;
    await chrome.storage.local.set({ wav_token: token });
  }

  async setPlan(plan) {
    this._plan = plan;
    await chrome.storage.local.set({ wav_plan: plan });
  }

  async syncWithBackend() {
    if (!this._token) return;
    try {
      const res = await fetch(`${API_BASE}/api/me`, {
        headers: { Authorization: `Bearer ${this._token}` },
      });
      if (!res.ok) {
        if (res.status === 401) {
          await this.setToken(null);
          await this.setPlan("free");
        }
        return;
      }
      const data = await res.json();
      await this.setPlan(data.plan || "free");
    } catch {
      // Offline — keep current plan
    }
  }

  _rotateDay() {
    const today = new Date().toISOString().slice(0, 10);
    if (this._dailyDate !== today) {
      this._dailyDate = today;
      this._dailyRemovals = 0;
      this._save();
    }
  }

  async _save() {
    await chrome.storage.local.set({
      wav_daily_removals: this._dailyRemovals,
      wav_daily_date: this._dailyDate,
    });
  }

  async _reportUsage(actionType) {
    if (!this._token) return;
    await fetch(`${API_BASE}/api/usage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this._token}`,
      },
      body: JSON.stringify({ action: actionType, date: this._dailyDate }),
    });
  }
}

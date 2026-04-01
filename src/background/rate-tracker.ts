/**
 * RateTracker — monitors action frequency and error rates.
 *
 * Ported from backend/engine/rate_tracker.py with identical logic.
 * State is persisted to chrome.storage.local for SW restart recovery.
 */

import type { SafetyProfile, Stats } from "@shared/types";
import {
  SAFETY_PROFILES,
  CONSECUTIVE_ERROR_LIMIT,
  ERROR_RATE_WINDOW,
  ERROR_RATE_THRESHOLD,
} from "@shared/constants";
import { getRateState, saveRateState, type RateState } from "./storage";

export class RateTracker {
  private profile;
  private state: RateState = {
    hourlyCount: 0,
    dailyCount: 0,
    hourKey: "",
    dayKey: "",
    consecutiveErrors: 0,
    recentResults: [],
  };
  private loaded = false;

  constructor(profileName: SafetyProfile = "normal") {
    this.profile = { ...SAFETY_PROFILES[profileName] };
  }

  async load(): Promise<void> {
    this.state = await getRateState();
    this.rotateCounters();
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await saveRateState(this.state);
  }

  setProfile(name: SafetyProfile): void {
    this.profile = { ...SAFETY_PROFILES[name] };
  }

  private rotateCounters(): void {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const hour = now.toISOString().slice(0, 13);

    if (this.state.dayKey !== today) {
      this.state.dayKey = today;
      this.state.dailyCount = 0;
    }
    if (this.state.hourKey !== hour) {
      this.state.hourKey = hour;
      this.state.hourlyCount = 0;
    }
  }

  async recordAction(): Promise<void> {
    if (!this.loaded) await this.load();
    this.rotateCounters();
    this.state.dailyCount++;
    this.state.hourlyCount++;
    await this.save();
  }

  async recordSuccess(): Promise<void> {
    if (!this.loaded) await this.load();
    this.state.consecutiveErrors = 0;
    this.state.recentResults.push(true);
    if (this.state.recentResults.length > ERROR_RATE_WINDOW) {
      this.state.recentResults = this.state.recentResults.slice(-ERROR_RATE_WINDOW);
    }
    await this.save();
  }

  async recordError(): Promise<void> {
    if (!this.loaded) await this.load();
    this.state.consecutiveErrors++;
    this.state.recentResults.push(false);
    if (this.state.recentResults.length > ERROR_RATE_WINDOW) {
      this.state.recentResults = this.state.recentResults.slice(-ERROR_RATE_WINDOW);
    }
    await this.save();
  }

  async resetErrors(): Promise<void> {
    if (!this.loaded) await this.load();
    this.state.consecutiveErrors = 0;
    this.state.recentResults = [];
    await this.save();
  }

  async resetAll(): Promise<void> {
    this.state = {
      hourlyCount: 0,
      dailyCount: 0,
      hourKey: new Date().toISOString().slice(0, 13),
      dayKey: new Date().toISOString().slice(0, 10),
      consecutiveErrors: 0,
      recentResults: [],
    };
    this.loaded = true;
    await this.save();
  }

  canAct(): boolean {
    this.rotateCounters();
    if (this.state.dailyCount >= this.profile.limitDay) return false;
    if (this.state.hourlyCount >= this.profile.limitHour) return false;
    return true;
  }

  shouldStop(): { stop: boolean; reason: string } {
    if (this.state.consecutiveErrors >= CONSECUTIVE_ERROR_LIMIT) {
      return {
        stop: true,
        reason: `${this.state.consecutiveErrors} consecutive errors — wait 15-30 min`,
      };
    }

    if (this.state.recentResults.length >= ERROR_RATE_WINDOW) {
      const errorRate =
        this.state.recentResults.filter((r) => !r).length / this.state.recentResults.length;
      if (errorRate >= ERROR_RATE_THRESHOLD) {
        return { stop: true, reason: `${Math.round(errorRate * 100)}% error rate — wait 15-30 min` };
      }
    }

    return { stop: false, reason: "" };
  }

  getStats(): Stats["rate"] {
    this.rotateCounters();
    return {
      actionsToday: this.state.dailyCount,
      actionsThisHour: this.state.hourlyCount,
      limitDay: this.profile.limitDay,
      limitHour: this.profile.limitHour,
      consecutiveErrors: this.state.consecutiveErrors,
    };
  }
}

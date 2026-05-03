/**
 * RateTracker — monitors action frequency and error rates.
 *
 * Fixed rate: 50 actions/hour max. No daily limit. No profiles.
 */

import type { Stats } from "@shared/types";
import {
  RATE_LIMIT_HOUR,
  CONSECUTIVE_ERROR_LIMIT,
  ERROR_RATE_WINDOW,
  ERROR_RATE_THRESHOLD,
} from "@shared/constants";
import { getRateState, saveRateState, type RateState } from "./storage";

export class RateTracker {
  private state: RateState = {
    hourlyCount: 0,
    hourKey: "",
    consecutiveErrors: 0,
    recentResults: [],
  };
  private loaded = false;

  async load(): Promise<void> {
    this.state = await getRateState();
    this.rotateCounters();
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await saveRateState(this.state);
  }

  private rotateCounters(): void {
    const now = new Date();
    const hour = now.toISOString().slice(0, 13);

    if (this.state.hourKey !== hour) {
      this.state.hourKey = hour;
      this.state.hourlyCount = 0;
    }
  }

  async recordAction(): Promise<void> {
    if (!this.loaded) await this.load();
    this.rotateCounters();
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

  canAct(): boolean {
    this.rotateCounters();
    return this.state.hourlyCount < RATE_LIMIT_HOUR;
  }

  shouldStop(): { stop: boolean; reason: string } {
    if (this.state.consecutiveErrors >= CONSECUTIVE_ERROR_LIMIT) {
      return {
        stop: true,
        reason: `${this.state.consecutiveErrors} consecutive errors`,
      };
    }

    if (this.state.recentResults.length >= ERROR_RATE_WINDOW) {
      const errorRate =
        this.state.recentResults.filter((r) => !r).length / this.state.recentResults.length;
      if (errorRate >= ERROR_RATE_THRESHOLD) {
        return { stop: true, reason: `${Math.round(errorRate * 100)}% error rate` };
      }
    }

    return { stop: false, reason: "" };
  }

  getStats(): Stats["rate"] {
    this.rotateCounters();
    return {
      actionsThisHour: this.state.hourlyCount,
      limitHour: RATE_LIMIT_HOUR,
      consecutiveErrors: this.state.consecutiveErrors,
    };
  }
}

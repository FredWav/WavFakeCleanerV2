/**
 * HumanPacer — organic, randomized delays to mimic human browsing.
 *
 * Ported from backend/engine/pacer.py with identical logic.
 */

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export class HumanPacer {
  private baseMin: number;
  private baseMax: number;
  private _actionCount = 0;
  private _sessionLength: number;

  constructor(baseMin = 4, baseMax = 8) {
    this.baseMin = baseMin;
    this.baseMax = baseMax;
    this._sessionLength = Math.floor(randomBetween(12, 25));
  }

  get actionCount(): number {
    return this._actionCount;
  }

  /** Return next pause duration for clean/heavy actions. */
  nextPause(): number {
    this._actionCount++;

    // Session fatigue: after a burst, big break (90-300s)
    if (this._actionCount >= this._sessionLength) {
      this._actionCount = 0;
      this._sessionLength = Math.floor(randomBetween(10, 25));
      return randomBetween(90, 300);
    }

    const roll = Math.random();
    if (roll < 0.7) {
      // Short pause: quick action
      return randomBetween(this.baseMin * 0.5, this.baseMax * 0.7);
    } else if (roll < 0.9) {
      // Medium pause: reading a profile
      return randomBetween(this.baseMax * 0.8, this.baseMax * 1.8);
    } else {
      // Long pause: human distraction
      return randomBetween(this.baseMax * 2, this.baseMax * 4);
    }
  }

  /** 8-15s base pauses for scanning, with human variation. */
  nextScanPause(): number {
    this._actionCount++;

    if (this._actionCount >= this._sessionLength) {
      this._actionCount = 0;
      this._sessionLength = Math.floor(randomBetween(8, 18));
      return randomBetween(120, 240);
    }

    const roll = Math.random();
    if (roll < 0.65) {
      return randomBetween(8, 12);
    } else if (roll < 0.88) {
      return randomBetween(12, 18);
    } else {
      return randomBetween(20, 35);
    }
  }
}

/** Sleep that can be cancelled via AbortSignal. */
export function sleep(seconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const id = setTimeout(resolve, seconds * 1000);
    signal?.addEventListener("abort", () => {
      clearTimeout(id);
      resolve();
    });
  });
}

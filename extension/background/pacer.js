/**
 * HumanPacer — organic, randomized delays to mimic human browsing.
 * Port from Python backend pacer.py.
 */

export class HumanPacer {
  constructor(baseMin = 8, baseMax = 15) {
    this.baseMin = baseMin;
    this.baseMax = baseMax;
    this._actionCount = 0;
    this._sessionLength = randInt(8, 18);
  }

  /** Return next pause duration for scan actions (8-15s base). */
  nextScanPause() {
    this._actionCount++;

    if (this._actionCount >= this._sessionLength) {
      this._actionCount = 0;
      this._sessionLength = randInt(8, 18);
      return randFloat(120, 240); // 2-4 min session break
    }

    const roll = Math.random();
    if (roll < 0.65) return randFloat(8, 12);
    if (roll < 0.88) return randFloat(12, 18);
    return randFloat(20, 35);
  }

  /** Return next pause duration for clean/heavy actions. */
  nextCleanPause() {
    this._actionCount++;

    if (this._actionCount >= this._sessionLength) {
      this._actionCount = 0;
      this._sessionLength = randInt(10, 25);
      return randFloat(90, 300);
    }

    const roll = Math.random();
    if (roll < 0.70) return randFloat(this.baseMin * 0.5, this.baseMax * 0.7);
    if (roll < 0.90) return randFloat(this.baseMax * 0.8, this.baseMax * 1.8);
    return randFloat(this.baseMax * 2, this.baseMax * 4);
  }
}

/** Interruptible delay — resolves early if abortSignal fires. */
export function sleep(ms, abortSignal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (abortSignal) {
      abortSignal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    }
  });
}

function randFloat(min, max) {
  return min + Math.random() * (max - min);
}

function randInt(min, max) {
  return Math.floor(randFloat(min, max + 1));
}

import type { SafetyProfile } from "./types";

// ── Safety profiles (from rate_tracker.py) ──

export interface SafetyProfileConfig {
  limitDay: number;
  limitHour: number;
  pauseMin: number;
  pauseMax: number;
  scanBatch: number;
  cleanBatch: number;
  antiBotEvery: number;
}

export const SAFETY_PROFILES: Record<SafetyProfile, SafetyProfileConfig> = {
  gratuit: {
    limitDay: 50,
    limitHour: 15,
    pauseMin: 20,
    pauseMax: 35,
    scanBatch: 200,
    cleanBatch: 50,
    antiBotEvery: 10,
  },
  prudent: {
    limitDay: 160,
    limitHour: 25,
    pauseMin: 15,
    pauseMax: 30,
    scanBatch: 80,
    cleanBatch: 160,
    antiBotEvery: 15,
  },
  normal: {
    limitDay: 300,
    limitHour: 40,
    pauseMin: 8,
    pauseMax: 15,
    scanBatch: 120,
    cleanBatch: 300,
    antiBotEvery: 20,
  },
  agressif: {
    limitDay: 500,
    limitHour: 50,
    pauseMin: 5,
    pauseMax: 10,
    scanBatch: 150,
    cleanBatch: 500,
    antiBotEvery: 25,
  },
};

// ── Error thresholds ──

export const CONSECUTIVE_ERROR_LIMIT = 8;
export const ERROR_RATE_WINDOW = 20;
export const ERROR_RATE_THRESHOLD = 0.6;

// ── Default settings ──

export const DEFAULT_SETTINGS = {
  threadsUsername: "",
  scoreThreshold: 70,
  safetyProfile: "gratuit" as SafetyProfile,
};

// ── Stripe licence ──

export const STRIPE_PAYMENT_LINK = "https://buy.stripe.com/REPLACE_WITH_YOUR_LINK";
export const LICENCE_PRICE = "7,99€";

// ── Autopilot constants ──

export const AUTOPILOT = {
  scanBatch: [120, 150] as [number, number],
  cleanBatch: [18, 30] as [number, number],
  pauseBetween: [300, 900] as [number, number],
  pauseScan: [900, 1500] as [number, number],
  pauseClean: [1500, 2100] as [number, number],
  cooldownOnErr: [600, 1200] as [number, number],
  fetchIntervalH: 5,
};

// ── Threads API ──

// API paths are relative — the content script runs on the Threads page,
// so fetch() uses the current origin (threads.net or threads.com).
export const THREADS_API = {
  appId: "238260118697367",
  followersEndpoint: "/api/v1/friendships/{user_id}/followers/",
  profileEndpoint: "/api/v1/users/web_profile_info/",
  searchEndpoint: "/api/v1/users/search/",
  pageSize: 50,
};

// ── Default pic patterns ──

export const DEFAULT_PIC_PATTERNS = ["default", "empty", "placeholder", "/44884218_345"];

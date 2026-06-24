import React, { useState, useEffect, useCallback, useRef } from "react";
import { api } from "../lib/messaging";
import { t } from "../lib/i18n";
import type { FollowerRecord, LicenseInfo } from "@shared/types";
import { COMMUNITY_LOOKUP_URL } from "@shared/constants";
import { IconGlobe, IconWarn, IconCheck, IconRefresh, IconChevronDown, IconChevronRight } from "./Icons";
import Skeleton from "./ui/Skeleton";

// ── Community lookup (inline — no storage deps, runs in side panel) ──

interface CommunityScore {
  voteCount: number;
  fakeRatio: number;      // 0.0–1.0
  consensusScore: number; // 0–100
}

// Usernames are stable — never hash the same one twice per panel session.
const sha256Cache = new Map<string, string>();

async function sha256Hex(str: string): Promise<string> {
  const cached = sha256Cache.get(str);
  if (cached) return cached;
  const data = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const hex = Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  sha256Cache.set(str, hex);
  return hex;
}

// Tell the service worker a lookup failed so it's counted and surfaced
// (community status card + telemetry) instead of dying in a silent catch.
function reportLookupFailure(httpStatus: number | null): void {
  chrome.runtime
    .sendMessage({ type: "COMMUNITY_LOOKUP_FAILED", payload: { httpStatus } })
    .catch(() => {});
}

async function fetchCommunityScores(usernames: string[]): Promise<Map<string, CommunityScore>> {
  const result = new Map<string, CommunityScore>();
  if (usernames.length === 0) return result;

  const hashToUser = new Map<string, string>();
  const hashes: string[] = [];
  for (const u of usernames) {
    const h = await sha256Hex(u.toLowerCase());
    hashToUser.set(h, u);
    hashes.push(h);
  }

  try {
    const res = await fetch(COMMUNITY_LOOKUP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetHashes: hashes }),
    });
    if (!res.ok) {
      reportLookupFailure(res.status);
      return result;
    }
    const data = await res.json() as Record<string, CommunityScore>;
    for (const [h, score] of Object.entries(data)) {
      const u = hashToUser.get(h);
      if (u) result.set(u, score);
    }
  } catch {
    // community features non-critical — but the failure is still counted
    reportLookupFailure(null);
  }
  return result;
}

function parseBreakdown(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// ── Breakdown technique → labels lisibles ──

interface ReadableItem {
  label: string;
  suspect: boolean; // true = orange warning, false = green positive
}

// The regex chains below re-ran for every row on every render (filter
// changes, expand/collapse, vote state…). Breakdown strings are immutable per
// follower, so cache the readable result by (breakdown, lang).
const readableCache = new Map<string, ReadableItem[]>();
const READABLE_CACHE_MAX = 600;

function readableBreakdown(raw: string | null, lang: string): ReadableItem[] {
  if (!raw) return [];
  const key = `${lang}|${raw}`;
  const cached = readableCache.get(key);
  if (cached) return cached;
  const computed = breakdownToReadable(parseBreakdown(raw), lang);
  if (readableCache.size >= READABLE_CACHE_MAX) readableCache.clear();
  readableCache.set(key, computed);
  return computed;
}

function breakdownToReadable(items: string[], lang: string): ReadableItem[] {
  const result: ReadableItem[] = [];
  const rawSet = new Set(items.map((i) => i.trim()));

  // Detect if !bio is in the breakdown — if so, link_bio/ig_link are false positives
  const hasNoBio = [...rawSet].some((r) => /^!bio\b/.test(r));

  for (const raw of items) {
    const r = raw.trim();

    // Suspect signals (score positif = +)
    if (/^0post\b/.test(r)) { result.push({ label: t("bd_no_posts", lang), suspect: true }); continue; }
    if (/^\d+post\b/.test(r) && r.includes("+")) { result.push({ label: t("bd_few_posts", lang), suspect: true }); continue; }
    if (/^0rep\b/.test(r)) { result.push({ label: t("bd_no_replies", lang), suspect: true }); continue; }
    if (/^!bio\b/.test(r)) { result.push({ label: t("bd_no_bio", lang), suspect: true }); continue; }
    if (/^0abn\b/.test(r) || (/^\d+abn\b/.test(r) && r.includes("+"))) { result.push({ label: t("bd_few_followers", lang), suspect: true }); continue; }
    if (/^combo\(/.test(r)) { result.push({ label: t("bd_no_activity", lang), suspect: true }); continue; }
    if (/^spam/.test(r)) { result.push({ label: t("bd_spam", lang), suspect: true }); continue; }
    if (/^ratio/.test(r)) { result.push({ label: t("bd_ratio", lang), suspect: true }); continue; }
    if (/^ghost/.test(r)) { result.push({ label: t("bd_ghost", lang), suspect: true }); continue; }
    if (/^inactive/.test(r)) { result.push({ label: t("bd_inactive", lang), suspect: true }); continue; }
    if (/^!name\b/.test(r)) { result.push({ label: t("bd_no_name", lang), suspect: true }); continue; }
    if (/^private/.test(r) && r.includes("+")) { result.push({ label: t("bd_private", lang), suspect: true }); continue; }
    if (/^@pattern|@digit|@no_letters/.test(r)) { result.push({ label: t("bd_suspect_username", lang), suspect: true }); continue; }
    if (/^rep_no_post/.test(r) || /^rep_spam/.test(r)) { result.push({ label: t("bd_no_posts", lang), suspect: true }); continue; }
    if (/^spammer/.test(r)) { result.push({ label: t("bd_spam", lang), suspect: true }); continue; }

    // Legitimacy signals (score négatif = -)
    if (/^bio\b/.test(r) && r.includes("-")) { result.push({ label: t("bd_has_bio", lang), suspect: false }); continue; }
    if (/^verified\b/.test(r)) { result.push({ label: t("bd_verified", lang), suspect: false }); continue; }
    // link_bio: skip if profile has no bio (faux positif du scraper)
    if (/^link_bio\b/.test(r)) { if (!hasNoBio) result.push({ label: t("bd_link_bio", lang), suspect: false }); continue; }
    // ig_link: skip si pas de bio (incohérent — le scraper détecte le badge IG natif)
    if (/^ig_link\b/.test(r)) { if (!hasNoBio) result.push({ label: t("bd_ig_link", lang), suspect: false }); continue; }
    if (/^has_media\b/.test(r)) { result.push({ label: t("bd_has_media", lang), suspect: false }); continue; }
    if (/^\d+post\b/.test(r) && r.includes("-")) { result.push({ label: t("bd_has_posts", lang), suspect: false }); continue; }
    if (/^rep\+posts\b/.test(r)) { result.push({ label: t("bd_has_replies", lang), suspect: false }); continue; }
    if (/^\d+abn\b/.test(r) && r.includes("-")) { result.push({ label: t("bd_many_followers", lang), suspect: false }); continue; }
    if (/^private\(legit/.test(r) || /^private\(semi/.test(r)) { result.push({ label: t("bd_private", lang), suspect: false }); continue; }

    // Fallback: skip unknown/neutral items (post? unknown, rep? unknown, etc.)
  }

  // Deduplicate by label
  const seen = new Set<string>();
  return result.filter((item) => {
    if (seen.has(item.label)) return false;
    seen.add(item.label);
    return true;
  });
}

const filters = [
  { key: "filter_all", param: "" },
  { key: "filter_pending", param: "pending" },
  { key: "filter_ok", param: "ok" },
  { key: "filter_review", param: "review" },
  { key: "filter_fake", param: "fake" },
  { key: "filter_removed", param: "removed" },
];

// ── Réutilise un seul onglet pour naviguer vers les profils ──
let profileTabId: number | null = null;
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === profileTabId) profileTabId = null;
});

async function openProfileTab(url: string): Promise<void> {
  if (profileTabId !== null) {
    try {
      await chrome.tabs.update(profileTabId, { url, active: true });
      return;
    } catch {
      profileTabId = null;
    }
  }
  const tab = await chrome.tabs.create({ url, active: true });
  profileTabId = tab.id ?? null;
}

// Export the removed-followers list as CSV (the "journal" half of the
// journal/undo model — true undo is impossible since Threads can't re-add a
// follower, so we give the user a portable record + profile links to re-follow).
function exportRemovedCsv(rows: FollowerWithUrl[]): void {
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const header = "username,score,removed_at,profile_url";
  const lines = rows.map((f) => {
    const date = f.removedAt ? new Date(f.removedAt).toISOString() : "";
    return [esc("@" + f.username), String(f.score ?? ""), esc(date), esc(f.profile_url)].join(",");
  });
  const csv = [header, ...lines].join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `wfc-removed-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function scoreBadge(score: number | null) {
  if (score === null || score === undefined) return null;
  let color = "bg-green-500/20 text-green-400";
  if (score >= 70) color = "bg-red-500/20 text-red-400";
  else if (score >= 40) color = "bg-yellow-500/20 text-yellow-400";
  return <span className={`px-1.5 py-0.5 rounded text-[11px] font-bold ${color}`}>{score}</span>;
}

function statusBadge(f: FollowerRecord, lang: string) {
  if (f.removed) return <span className="text-green-400 text-[11px]">{t("filter_removed", lang)}</span>;
  if (f.toReview) return <span className="text-orange-400 text-[11px]">{t("to_review", lang)}</span>;
  if (f.approved) return <span className="text-emerald-400 text-[11px]">{t("approved", lang)}</span>;
  if (f.isFake) return <span className="text-red-400 text-[11px]">{t("filter_fake", lang)}</span>;
  if (f.scanned) return <span className="text-cyan-400 text-[11px]">OK</span>;
  return <span className="text-gray-500 text-[11px]">{t("filter_pending", lang)}</span>;
}

type FollowerWithUrl = FollowerRecord & { profile_url: string };

export default function FollowerTable({
  lang,
  licence,
  onShowLicence,
  showToast,
  refreshTrigger,
}: {
  lang: string;
  licence?: LicenseInfo;
  onShowLicence?: () => void;
  showToast?: (msg: string) => void;
  refreshTrigger?: number;
}) {
  const [followers, setFollowers] = useState<FollowerWithUrl[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [communityScores, setCommunityScores] = useState<Map<string, CommunityScore>>(new Map());
  const [myVotes, setMyVotes] = useState<Map<string, "fake" | "ok">>(new Map());
  const [voteLoading, setVoteLoading] = useState<string | null>(null);
  const [licencePrompt, setLicencePrompt] = useState<string | null>(null);

  // Skip the community-score refetch when the visible username set hasn't
  // changed (e.g. expanding a row, toggling a vote) — one Worker call per
  // actual list change instead of one per render trigger.
  const lastLookupKey = useRef<string>("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getFollowers(filter || undefined, 200, search || undefined);
      setFollowers(data);
      const scanned = data.filter((f) => f.scanned && !f.removed).map((f) => f.username);
      if (scanned.length > 0) {
        const lookupKey = scanned.slice(0, 200).join("\n");
        if (lookupKey !== lastLookupKey.current) {
          lastLookupKey.current = lookupKey;
          fetchCommunityScores(scanned.slice(0, 200))
            .then((scores) => setCommunityScores(scores))
            .catch(() => {});
        }
      }
    } catch {
      showToast?.(t("action_failed", lang)); // U-M1 : ne plus avaler en silence
    } finally {
      setLoading(false);
    }
  }, [filter, search, showToast, lang]);

  useEffect(() => {
    const timer = setTimeout(() => load(), search ? 300 : 0);
    return () => clearTimeout(timer);
  }, [load, refreshTrigger]);

  async function handleApprove(e: React.MouseEvent, username: string) {
    e.stopPropagation();
    setActionLoading(username);
    try {
      await api.approveFollower(username);
      await load();
    } catch { showToast?.(t("action_failed", lang)); } finally {
      setActionLoading(null);
    }
  }

  async function handleReject(e: React.MouseEvent, username: string) {
    e.stopPropagation();
    setActionLoading(username);
    try {
      await api.rejectFollower(username);
      await load();
    } catch { showToast?.(t("action_failed", lang)); } finally {
      setActionLoading(null);
    }
  }

  async function handleVote(e: React.MouseEvent, username: string, verdict: "fake" | "ok", score: number) {
    e.stopPropagation();

    // Not licensed → upsell
    if (!licence?.active) {
      setLicencePrompt(username);
      return;
    }

    setVoteLoading(username);
    try {
      // Action locale : Fake = rejeter, No Fake = approuver
      if (verdict === "fake") {
        await api.rejectFollower(username);
        showToast?.(t("toast_remove_ok", lang));
      } else {
        await api.approveFollower(username);
      }
      showToast?.(t("toast_vote_ok", lang));
      // Vote communautaire (fire-and-forget)
      api.submitCommunityVote(username, verdict, score).catch(() => {});
      setMyVotes((prev) => { const next = new Map(prev); next.set(username, verdict); return next; });
      fetchCommunityScores([username])
        .then((scores) => {
          setCommunityScores((prev) => {
            const next = new Map(prev);
            const s = scores.get(username);
            if (s) next.set(username, s);
            return next;
          });
        })
        .catch(() => {});
      await load();
    } catch { showToast?.(t("action_failed", lang)); } finally {
      setVoteLoading(null);
    }
  }

  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800">
      {/* Filter bar */}
      <div className="flex gap-1 p-1.5 border-b border-gray-800 flex-wrap items-center">
        {filters.map(({ key, param }) => (
          <button
            key={key}
            onClick={() => setFilter(param)}
            className={`px-2 py-0.5 rounded-lg text-[11px] font-medium transition-colors
              ${filter === param ? "bg-gray-700 text-white" : "text-gray-500 hover:text-gray-300"}`}
          >
            {t(key, lang)}
          </button>
        ))}
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("search_placeholder", lang)}
          className="ml-auto px-2 py-0.5 rounded-lg text-[11px] bg-gray-800 border border-gray-700
            text-gray-300 placeholder-gray-600 outline-none focus:border-purple-500 w-28"
        />
        <button onClick={load} aria-label={t("refresh", lang)} title={t("refresh", lang)} className="text-gray-500 hover:text-gray-300 px-1">
          <IconRefresh />
        </button>
      </div>

      {/* Removed journal: honesty note about re-follow + CSV export */}
      {filter === "removed" && (
        <div className="flex items-start gap-2 px-2 py-1.5 border-b border-gray-800 text-[11px] text-gray-500">
          <span className="leading-snug flex-1">{t("removed_note", lang)}</span>
          {followers.length > 0 && (
            <button
              onClick={() => exportRemovedCsv(followers)}
              className="px-2 py-0.5 rounded bg-gray-800 text-gray-300 hover:text-white transition-colors shrink-0"
            >
              {t("export_csv", lang)}
            </button>
          )}
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto max-h-72 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-gray-900">
            <tr className="text-gray-500 text-[11px] uppercase">
              <th className="text-left px-2 py-1.5">{t("follower", lang)}</th>
              <th className="text-center px-1 py-1.5">{t("score", lang)}</th>
              <th className="text-center px-1 py-1.5">{t("status", lang)}</th>
            </tr>
          </thead>
          <tbody>
            {loading && followers.length === 0 ? (
              // Skeleton rows: same geometry as real rows, no layout jump.
              Array.from({ length: 6 }, (_, i) => (
                <tr key={`skeleton-${i}`} className="border-t border-gray-800/50">
                  <td className="px-2 py-2"><Skeleton className="h-3.5 w-28" /></td>
                  <td className="px-1 py-2"><Skeleton className="h-3.5 w-7 mx-auto" /></td>
                  <td className="px-1 py-2"><Skeleton className="h-3.5 w-12 mx-auto" /></td>
                </tr>
              ))
            ) : followers.length === 0 ? (
              <tr>
                <td colSpan={3} className="text-center py-8">
                  {filter === "fake" ? (
                    // Empty "fake" tab is GOOD news — say so instead of "no data".
                    <div className="space-y-1">
                      <div className="text-green-400 text-base" aria-hidden="true">✓</div>
                      <p className="text-xs text-gray-400">{t("empty_no_fakes", lang)}</p>
                    </div>
                  ) : !filter && !search ? (
                    <div className="space-y-1">
                      <p className="text-xs text-gray-400">{t("empty_no_followers", lang)}</p>
                      <p className="text-[11px] text-gray-600">{t("empty_no_followers_hint", lang)}</p>
                    </div>
                  ) : (
                    <span className="text-xs text-gray-600">{t("no_data", lang)}</span>
                  )}
                </td>
              </tr>
            ) : (
              followers.map((f, index) => {
                const isExpanded = expanded === f.username;
                const readable = readableBreakdown(f.scoreBreakdown, lang);
                const cs = communityScores.get(f.username);
                const isSpotted = cs && cs.voteCount >= 3 && cs.fakeRatio >= 0.60;
                const isFakeFilter = filter === "fake";
                const isLockedRow = isFakeFilter && !licence?.active && index >= 5;

                // Unlicensed users on the Fake tab: show one clean upsell banner
                // in place of row 5 and hide the rest — no jarring per-row blur.
                if (isLockedRow) {
                  if (index !== 5) return null;
                  return (
                    <tr key="paywall">
                      <td colSpan={3} className="px-3 py-5 text-center bg-gradient-to-b from-transparent to-gray-900">
                        <p className="text-xs text-gray-300 mb-2">
                          {t("blur_banner_count", lang)
                            .replace("{0}", String(followers.length))
                            .replace("{1}", String(Math.max(0, followers.length - 5)))}
                        </p>
                        <button
                          onClick={() => onShowLicence?.()}
                          className="px-3 py-1.5 bg-purple-600 text-white text-xs font-medium rounded-lg
                            hover:bg-purple-500 transition-colors"
                        >
                          {t("blur_cta", lang)}
                        </button>
                      </td>
                    </tr>
                  );
                }

                return (
                  <React.Fragment key={f.username}>
                    {/* Main row */}
                    <tr
                      onClick={() => { setExpanded(isExpanded ? null : f.username); setLicencePrompt(null); }}
                      className="border-t border-gray-800/50 hover:bg-gray-800/30 cursor-pointer transition-colors animate-row-in"
                    >
                      <td className="px-2 py-1.5 font-mono text-gray-300">
                        <a
                          href={f.profile_url}
                          rel="noopener noreferrer"
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); openProfileTab(f.profile_url); }}
                          className="text-purple-400 hover:text-purple-300 hover:underline transition-colors"
                        >
                          @{f.username}
                        </a>
                        {f.isPrivate && <span className="ml-1 text-[11px] text-gray-600" title="Private">P</span>}
                        {isSpotted && (
                          <span className="ml-1 px-1 py-0.5 rounded text-[11px] bg-orange-500/20 text-orange-400 font-medium">
                            {t("spotted_by_community", lang)}
                          </span>
                        )}
                        <span className="ml-1 text-gray-600">{isExpanded ? <IconChevronDown /> : <IconChevronRight />}</span>
                      </td>
                      <td className="text-center px-1 py-1.5">{scoreBadge(f.score)}</td>
                      <td className="text-center px-1 py-1.5">
                        <div className="flex items-center justify-center gap-1">
                          {statusBadge(f, lang)}
                        </div>
                      </td>
                    </tr>

                    {/* Expanded detail */}
                    {isExpanded && (
                      <tr className="bg-gray-800/40">
                        <td colSpan={3} className="px-3 py-2 space-y-2">

                          {/* Section 1: Infos compte */}
                          <div className="text-[11px] text-gray-500 flex flex-wrap gap-x-2">
                            {f.followersCount !== null && (
                              <span>{f.followersCount} {t("info_followers", lang)}</span>
                            )}
                            {f.followingCount !== null && (
                              <span>{f.followingCount} {t("info_following", lang)}</span>
                            )}
                            <span>{f.isPrivate ? t("info_private", lang) : t("info_public", lang)}</span>
                            {f.removed && f.removedAt ? (
                              <span className="text-green-500/70">
                                {t("info_removed_on", lang).replace("{0}", new Date(f.removedAt).toLocaleDateString())}
                              </span>
                            ) : f.scannedAt ? (
                              <span>{new Date(f.scannedAt).toLocaleDateString()}</span>
                            ) : null}
                          </div>

                          {/* Section 2: Analyse lisible */}
                          {readable.length > 0 && (
                            <div>
                              <div className="text-[11px] text-gray-600 uppercase font-medium mb-0.5">
                                {t("analysis", lang)}
                              </div>
                              <div className="flex flex-wrap gap-1">
                                {readable.map((item, i) => (
                                  <span
                                    key={i}
                                    className={`px-1.5 py-0.5 rounded text-[11px] ${
                                      item.suspect
                                        ? "bg-red-500/15 text-red-400"
                                        : "bg-green-500/15 text-green-400"
                                    }`}
                                  >
                                    {item.suspect ? <IconWarn /> : <IconCheck />} {item.label}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Section 3: Vote communautaire */}
                          {f.score !== null && f.score >= 40 && (
                            <div className="border border-blue-900/40 rounded-lg px-2 py-1.5 bg-blue-950/20">
                              <div className="text-[11px] text-blue-400/70 uppercase font-semibold mb-1 tracking-wide flex items-center gap-1">
                                <IconGlobe /> {t("community_vote", lang)}
                              </div>
                              <div className="flex items-center gap-2 flex-wrap">
                                {licencePrompt === f.username ? (
                                  /* Upsell sans licence */
                                  <div className="flex items-center gap-1.5">
                                    <span className="text-[11px] text-purple-300">
                                      {t("vote_licence_required", lang)}
                                    </span>
                                    <button
                                      onClick={(e) => { e.stopPropagation(); onShowLicence?.(); setLicencePrompt(null); }}
                                      className="px-2 py-0.5 rounded text-[11px] bg-purple-600 text-white font-medium
                                        hover:bg-purple-500 transition-colors"
                                    >
                                      {t("vote_licence_cta", lang)}
                                    </button>
                                  </div>
                                ) : myVotes.has(f.username) ? (
                                  /* Déjà voté */
                                  <div className="flex items-center gap-1.5">
                                    <span className="text-[11px] text-gray-400">
                                      {t("vote_submitted", lang)}:{" "}
                                      <span className={myVotes.get(f.username) === "fake" ? "text-red-400 font-medium" : "text-green-400 font-medium"}>
                                        {myVotes.get(f.username) === "fake" ? t("vote_fake", lang) : t("vote_not_fake", lang)}
                                      </span>
                                    </span>
                                    <button
                                      onClick={(e) => handleVote(e, f.username, myVotes.get(f.username) === "fake" ? "ok" : "fake", f.score!)}
                                      disabled={voteLoading === f.username}
                                      aria-label={t("vote_change", lang)}
                                      title={t("vote_change", lang)}
                                      className="px-1 py-0.5 rounded text-[11px] bg-gray-700/50 text-gray-400
                                        hover:text-white transition-colors disabled:opacity-50"
                                    >
                                      <IconRefresh />
                                    </button>
                                  </div>
                                ) : (
                                  /* Boutons de vote */
                                  <>
                                    <button
                                      onClick={(e) => handleVote(e, f.username, "fake", f.score!)}
                                      disabled={voteLoading === f.username}
                                      className="px-2.5 py-1 rounded text-[11px] bg-red-600/25 text-red-400 font-semibold
                                        hover:bg-red-600/40 transition-colors disabled:opacity-50 border border-red-900/40"
                                    >
                                      Fake
                                    </button>
                                    <button
                                      onClick={(e) => handleVote(e, f.username, "ok", f.score!)}
                                      disabled={voteLoading === f.username}
                                      className="px-2.5 py-1 rounded text-[11px] bg-green-600/25 text-green-400 font-semibold
                                        hover:bg-green-600/40 transition-colors disabled:opacity-50 border border-green-900/40"
                                    >
                                      No Fake
                                    </button>
                                  </>
                                )}
                                {/* Résultat communautaire */}
                                {cs && cs.voteCount > 0 && (
                                  <span className="text-[11px] text-gray-500 ml-auto">
                                    {cs.voteCount} votes · {Math.round(cs.fakeRatio * 100)}% fake
                                  </span>
                                )}
                              </div>
                            </div>
                          )}


                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {followers.length >= 200 && (
        <div className="px-2 py-1 text-[11px] text-gray-600 border-t border-gray-800 text-center">
          {t("list_capped", lang)}
        </div>
      )}
    </div>
  );
}

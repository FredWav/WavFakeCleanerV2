/**
 * Allowlist for the MAIN-world bridge.
 *
 * The bridge (src/content/main-world-bridge.ts) fetches with the user's auth
 * cookies (credentials:"include"), so it must only ever be coerced into hitting
 * Threads' own API. This pattern is the SSRF guard.
 *
 * It accepts BOTH forms the interceptor may send:
 *   - absolute: https://(www.)threads.(net|com)/api/...
 *   - same-origin relative: /api/...   (the browser resolves these against the
 *     page origin, which is always a Threads host, so they can't escape origin)
 *
 * Why relative is allowed: api-interceptor.ts builds endpoints from relative
 * paths ("/api/v1/..."). A previous tightening (commit 051330c) restricted the
 * allowlist to the absolute form only, which silently rejected EVERY API call
 * (url_not_allowed) and forced the whole fetch onto the fragile scroll fallback.
 * Accepting the relative form too means a relative URL can never again kill the
 * API path. See src/shared/api-allowlist.test.ts for the regression guard.
 */

export const ALLOWED_API_URL_PATTERN =
  /^(?:https:\/\/(?:www\.)?threads\.(?:net|com))?\/api\//;

export function isAllowedApiUrl(url: unknown): url is string {
  return typeof url === "string" && ALLOWED_API_URL_PATTERN.test(url);
}

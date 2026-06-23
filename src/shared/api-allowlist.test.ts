import { describe, it, expect } from "vitest";
import { isAllowedApiUrl } from "./api-allowlist";
import { THREADS_API } from "./constants";

describe("api allowlist", () => {
  const origin = "https://www.threads.com";
  const abs = (rel: string) => new URL(rel, origin).toString();

  it("accepts the ABSOLUTE Threads API URLs the interceptor builds", () => {
    expect(isAllowedApiUrl(abs(`${THREADS_API.profileEndpoint}?username=fred`))).toBe(true);
    expect(
      isAllowedApiUrl(
        abs(THREADS_API.followersEndpoint.replace("{user_id}", "123") + "?count=50"),
      ),
    ).toBe(true);
    expect(isAllowedApiUrl(abs(`${THREADS_API.searchEndpoint}?q=fred`))).toBe(true);
  });

  // Regression guard for 051330c: the bridge allowlist was https-anchored while
  // the interceptor sent relative paths, so every API call was rejected and the
  // fetch fell back to the broken scroll path.
  it("accepts SAME-ORIGIN RELATIVE /api/ URLs", () => {
    expect(isAllowedApiUrl(`${THREADS_API.profileEndpoint}?username=fred`)).toBe(true);
    expect(isAllowedApiUrl("/api/v1/users/web_profile_info/?username=x")).toBe(true);
  });

  it("accepts threads.net as well as threads.com", () => {
    expect(isAllowedApiUrl("https://www.threads.net/api/v1/users/search/?q=x")).toBe(true);
    expect(isAllowedApiUrl("https://threads.com/api/v1/x")).toBe(true);
  });

  it("rejects non-Threads / non-/api/ URLs (SSRF guard intact)", () => {
    expect(isAllowedApiUrl("https://evil.com/api/x")).toBe(false);
    expect(isAllowedApiUrl("https://www.threads.com/@fred")).toBe(false);
    expect(isAllowedApiUrl("https://threads.com.evil.com/api/x")).toBe(false);
    expect(isAllowedApiUrl("//evil.com/api/x")).toBe(false);
    expect(isAllowedApiUrl("/profile/api/x")).toBe(false);
    expect(isAllowedApiUrl(null)).toBe(false);
    expect(isAllowedApiUrl(123)).toBe(false);
    expect(isAllowedApiUrl(undefined)).toBe(false);
  });
});

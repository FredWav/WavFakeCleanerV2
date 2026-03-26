const BASE = "/api"

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.detail || res.statusText)
  }
  return res.json()
}

export const api = {
  getStats: () => request("/stats"),
  getFollowers: (params = "") => request(`/followers${params ? "?" + params : ""}`),
  getLogs: (limit = 50) => request(`/logs?limit=${limit}`),
  getSettings: () => request("/settings"),
  getSessions: () => request("/sessions"),

  fetch: () => request("/fetch", { method: "POST" }),
  scan: (batch) => request(`/scan${batch ? "?batch_size=" + batch : ""}`, { method: "POST" }),
  clean: (batch) => request(`/clean${batch ? "?batch_size=" + batch : ""}`, { method: "POST" }),
  autopilot: () => request("/autopilot", { method: "POST" }),
  stop: () => request("/stop", { method: "POST" }),

  updateSettings: (body) => request("/settings", {
    method: "PATCH",
    body: JSON.stringify(body),
  }),
}

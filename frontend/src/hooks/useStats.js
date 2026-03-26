import { useState, useEffect, useCallback } from "react"
import { api } from "../lib/api"

export function useStats(intervalMs = 3000) {
  const [stats, setStats] = useState(null)
  const [error, setError] = useState(null)

  const refresh = useCallback(async () => {
    try {
      const data = await api.getStats()
      setStats(data)
      setError(null)
    } catch (e) {
      setError(e.message)
    }
  }, [])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, intervalMs)
    return () => clearInterval(id)
  }, [refresh, intervalMs])

  return { stats, error, refresh }
}

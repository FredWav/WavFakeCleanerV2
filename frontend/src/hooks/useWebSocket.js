import { useEffect, useRef, useState, useCallback } from "react"

export function useWebSocket(maxLogs = 200) {
  const [logs, setLogs] = useState([])
  const [connected, setConnected] = useState(false)
  const wsRef = useRef(null)
  const reconnectTimer = useRef(null)

  const connect = useCallback(() => {
    const proto = window.location.protocol === "https:" ? "wss" : "ws"
    const host = window.location.host
    const ws = new WebSocket(`${proto}://${host}/ws/logs`)

    ws.onopen = () => {
      setConnected(true)
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current)
        reconnectTimer.current = null
      }
    }

    ws.onmessage = (event) => {
      try {
        const entry = JSON.parse(event.data)
        if (entry.type === "ping") return
        setLogs((prev) => {
          const next = [...prev, entry]
          return next.length > maxLogs ? next.slice(-maxLogs) : next
        })
      } catch {
        // ignore parse errors
      }
    }

    ws.onclose = () => {
      setConnected(false)
      reconnectTimer.current = setTimeout(connect, 3000)
    }

    ws.onerror = () => ws.close()

    wsRef.current = ws
  }, [maxLogs])

  useEffect(() => {
    connect()
    return () => {
      if (wsRef.current) wsRef.current.close()
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
    }
  }, [connect])

  const clearLogs = useCallback(() => setLogs([]), [])

  return { logs, connected, clearLogs }
}

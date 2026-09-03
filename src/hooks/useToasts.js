import { useCallback, useState } from 'react'

let nextId = 1

export function useToasts() {
  const [toasts, setToasts] = useState([])

  const push = useCallback((toast) => {
    const id = nextId++
    setToasts((prev) => [...prev, { id, tone: 'info', ...toast }])
    return id
  }, [])

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  return { toasts, push, dismiss }
}

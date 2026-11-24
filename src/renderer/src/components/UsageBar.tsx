import { useEffect, useState } from 'react'
import type { DailyTokens, PlanLimits, PlanWindow, SessionMeta } from '../../../shared/types'

const api = window.clawhip

// 182_345_678 → "182.3M"
function compact(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(n)
}

function resetLabel(sec: number | null): string {
  if (!sec) return ''
  const d = new Date(sec * 1000)
  const now = new Date()
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (d.toDateString() === now.toDateString()) return `↻ ${time}`
  return `↻ ${d.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`
}

const level = (pct: number) => (pct >= 90 ? 'crit' : pct >= 70 ? 'warn' : 'ok')

function Meter({ label, pct, title, sub }: { label: string; pct: number | null; title: string; sub?: string }) {
  const v = pct === null ? null : Math.max(0, Math.min(100, pct))
  return (
    <div className="meter" title={title}>
      <span className="meter-label">{label}</span>
      <span className={`meter-bar ${v === null ? '' : level(v)}`}>
        <span style={{ width: `${v ?? 0}%` }} />
      </span>
      <span className="meter-pct">{v === null ? '—' : `${Math.round(v)}%`}</span>
      {sub && <span className="meter-sub">{sub}</span>}
    </div>
  )
}

function windowMeter(label: string, w: PlanWindow | null | undefined, stale: boolean, name: string) {
  const reset = w ? resetLabel(w.resetsAt) : ''
  const title = w
    ? `${name} plan limit: ${w.pct.toFixed(1)}% used${reset ? ` · resets ${reset.slice(2)}` : ''}${stale ? '\nLast reading may be old: it updates when a session gets a reply.' : ''}`
    : `${name} plan limit: no data yet. It appears after a betools session gets a reply (Pro/Max plans only).`
  return <Meter label={label} pct={w?.pct ?? null} title={title} sub={reset} />
}

export function UsageBar({ sessionId }: { sessionId: string | null }) {
  const [meta, setMeta] = useState<Record<string, SessionMeta>>({})
  const [limits, setLimits] = useState<PlanLimits | null>(null)
  const [daily, setDaily] = useState<DailyTokens | null>(null)
  // Re-render each minute so "resets" labels and staleness stay current.
  const [, tick] = useState(0)

  useEffect(() => {
    api.getUsage().then((u) => {
      setMeta(u.meta)
      setLimits(u.limits)
      setDaily(u.daily)
    })
    const offs = [
      api.onMeta((id, m) => setMeta((prev) => ({ ...prev, [id]: m }))),
      api.onLimits(setLimits),
      api.onDaily(setDaily)
    ]
    const t = setInterval(() => tick((n) => n + 1), 60_000)
    return () => {
      offs.forEach((off) => off())
      clearInterval(t)
    }
  }, [])

  const m = sessionId ? meta[sessionId] : undefined
  const now = Date.now() / 1000
  // A window whose reset time already passed is back at 0 even if no new reading arrived.
  const fresh = (w: PlanWindow | null | undefined) => (w && w.resetsAt && w.resetsAt < now ? { ...w, pct: 0 } : w)
  const stale = !!limits && Date.now() - limits.updatedAt > 15 * 60_000

  return (
    <div className="usage-bar">
      {sessionId && (
        <>
          <div className="usage-model" title="Model used by the selected session">
            {m?.model ?? '—'}
          </div>
          <Meter
            label="Context"
            pct={m?.contextPct ?? null}
            title="Context window used by the selected session (as reported by Claude Code)"
          />
          <span className="usage-sep" />
        </>
      )}
      {windowMeter('5h', fresh(limits?.fiveHour), stale, '5-hour')}
      {windowMeter('Week', fresh(limits?.sevenDay), stale, 'Weekly')}
      <span className="usage-sep" />
      <div
        className="usage-today"
        title={
          daily
            ? `Tokens today across all Claude Code sessions (${daily.messages} replies)\n` +
              `Input: ${daily.input.toLocaleString('en-US')}\n` +
              `Output: ${daily.output.toLocaleString('en-US')}\n` +
              `Cache write: ${daily.cacheWrite.toLocaleString('en-US')}\n` +
              `Cache read: ${daily.cacheRead.toLocaleString('en-US')}`
            : ''
        }
      >
        <span className="meter-label">Today</span>
        <strong>{daily ? compact(daily.total) : '—'}</strong>
        <span className="meter-sub">tokens</span>
      </div>
    </div>
  )
}

import { recallByDateRange, recallSearch, getDailyLogDates } from '../../db.js'
import { MAIN_AGENT_ID, APP_TZ } from '../../config.js'
import { json, jsonMaybeGzip } from '../http-helpers.js'
import { parseDateExpr } from '../../date-range.js'
import type { RouteContext } from './types.js'

const TZ = APP_TZ  // install zone (config.APP_TZ); was hardcoded Europe/Budapest

function todayBudapest(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(new Date())
}

/** Kept under the old name: the parser itself now lives in src/date-range.ts. */
export const parseDateExpression = parseDateExpr

export async function tryHandleRecall(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (method !== 'GET' || (path !== '/api/recall' && path !== '/api/recall/dates')) return false
  const rawLimit = url.searchParams.get('limit')
  if (rawLimit && !/^\d+$/.test(rawLimit)) {
    json(res, { error: 'limit must be a non-negative integer' }, 400)
    return true
  }

  if (path === '/api/recall') {
    const dateExpr = url.searchParams.get('date') || ''
    const query = url.searchParams.get('q') || ''
    const agent = url.searchParams.get('agent') || undefined
    const limit = Math.min(Number(rawLimit || 50), 200)

    if (query && !dateExpr) {
      const result = recallSearch(query, agent, limit)
      const formatted = formatRecallResult(result)
      jsonMaybeGzip(req, res, formatted)
      return true
    }

    const range = dateExpr ? parseDateExpression(dateExpr) : { from: todayBudapest(), to: todayBudapest() }
    if (!range) {
      json(res, { error: `Nem értelmezhető dátum: "${dateExpr}"` }, 400)
      return true
    }

    const result = recallByDateRange(range.from, range.to, agent, { query, limit: rawLimit ? limit : undefined })
    jsonMaybeGzip(req, res, { ...formatRecallResult(result), hasMore: result.hasMore })
    return true
  }

  const agent = url.searchParams.get('agent') || MAIN_AGENT_ID
  const limit = Math.min(Number(rawLimit || 90), 365)
  jsonMaybeGzip(req, res, getDailyLogDates(agent, limit))
  return true
}

function formatRecallResult(result: { logs: any[]; memories: any[]; dateRange: { from: string; to: string } }) {
  return {
    dateRange: result.dateRange,
    logs: result.logs.map(l => ({
      ...l,
      created_label: new Date(l.created_at * 1000).toLocaleString('hu-HU', { timeZone: TZ }),
    })),
    memories: result.memories.map(m => ({
      ...m,
      embedding: undefined,
      created_label: new Date(m.created_at * 1000).toLocaleString('hu-HU', { timeZone: TZ }),
    })),
    summary: {
      logCount: result.logs.length,
      memoryCount: result.memories.length,
      agents: [...new Set([...result.logs.map(l => l.agent_id), ...result.memories.map(m => m.agent_id)])],
    },
  }
}

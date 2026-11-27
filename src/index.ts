import { setTimeout as sleep } from 'node:timers/promises'
import type {
  SeoProviderActionAdapter,
  SeoProviderActivate,
  SeoProviderConnection,
  SeoProviderJson,
  SeoProviderRuntime,
  SeoSearchMarket,
  SeoSerpOrganicResult,
  SeoSerpSnapshotResult,
} from 'seo/provider-sdk'

const API = 'https://api.cloro.dev'
const RESULTS_PER_PAGE = 10
const MAX_DEPTH = 100
// The Lite plan rate ($30 for 37,500 credits), the highest per-credit rate
// of the paid plans. Larger plans pay less, so the estimate is an upper
// bound.
const MICROS_PER_CREDIT = 800
const MAX_KEYWORDS = 5
const MAX_QUESTIONS = 5
const MAX_SOURCES = 8
// Bing Search and Bing AI Mode refuse a query longer than this after URL
// encoding.
const BING_PROMPT_LIMIT = 3_500
// Bing counts the query after URL encoding, with a space as "+".
const bingPromptLength = (prompt: string) =>
  encodeURIComponent(prompt.trim()).replace(/%20/gu, '+').length

// cloro's search engines for the serp action, by the taskType of its async
// API.
const SEARCH_ENGINES = { google: 'GOOGLE', bing: 'BING' } as const
type SearchEngineName = keyof typeof SEARCH_ENGINES
const SEARCH_ENGINE_NAMES = Object.keys(SEARCH_ENGINES) as SearchEngineName[]

// cloro's AI engines, by the taskType of its async API, with the credits
// one answer costs.
const ENGINES = {
  chatgpt: { type: 'CHATGPT', credits: 5 },
  google_ai_mode: { type: 'AIMODE', credits: 4 },
  gemini: { type: 'GEMINI', credits: 4 },
  bing_ai_mode: { type: 'BING_AIMODE', credits: 4 },
} as const
type EngineName = keyof typeof ENGINES
const ENGINE_NAMES = Object.keys(ENGINES) as EngineName[]

type Item = Record<string, unknown>

function failure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

function apiKey(connection: SeoProviderConnection): string {
  const value = connection.credentials.apiKey?.trim() ?? ''
  if (!value || value.length > 4_096) {
    throw failure('authentication', 'cloro needs a valid API key.')
  }
  return value
}

function headers(connection: SeoProviderConnection): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey(connection)}`,
    'content-type': 'application/json',
  }
}

const items = (value: unknown): Item[] =>
  Array.isArray(value)
    ? value.filter((item): item is Item => typeof item === 'object' && !!item)
    : []
const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null

function country(value: unknown): string {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : 'US'
  if (!/^[A-Z]{2}$/u.test(code)) {
    throw failure('configuration', 'Use a two-letter country code, such as US.')
  }
  return code
}

// An http(s) URL, or null. A link cloro could not resolve comes back empty
// or as a Google /goto redirect.
function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const parsed = new URL(value)
    if (!['http:', 'https:'].includes(parsed.protocol)) return null
    if (
      /(^|\.)google\.[a-z.]+$/u.test(parsed.hostname) &&
      parsed.pathname.startsWith('/goto')
    ) {
      return null
    }
    parsed.username = ''
    parsed.password = ''
    return parsed.toString()
  } catch {
    return null
  }
}

const hostOf = (url: string | null): string | null => {
  if (!url) return null
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

// --- Connection ------------------------------------------------------------

async function verify(
  connection: SeoProviderConnection,
  runtime: SeoProviderRuntime,
): Promise<void> {
  const credits = (await runtime.requestJson({
    operation: 'verify',
    url: `${API}/v1/credits`,
    headers: headers(connection),
  })) as Item | null
  if (typeof credits?.remaining !== 'number') {
    throw failure('invalid-response', 'cloro returned invalid credit data.')
  }
}

// --- SERP snapshot ------------------------------------------------------------
// One async Google task, read until it finishes. A sync request can take
// longer than the host's 15-second request timeout when cloro retries, and
// the async API costs 2 credits less.

function snapshotMarket(value: SeoSearchMarket) {
  if (value.searchEngine !== 'google') {
    throw failure('configuration', 'cloro SERP snapshots support Google.')
  }
  if (value.location) {
    throw failure(
      'configuration',
      'cloro SERP snapshots take country-level markets. Omit the location.',
    )
  }
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/iu.test(value.languageCode)) {
    throw failure('configuration', 'Use a valid language code, such as en.')
  }
  return {
    countryCode: country(value.countryCode),
    languageCode: value.languageCode,
    device: value.device ?? 'desktop',
  }
}

function pagesFor(depth: number): number {
  if (!Number.isSafeInteger(depth) || depth < 1 || depth > MAX_DEPTH) {
    throw failure(
      'configuration',
      `cloro SERP depth must be from 1 to ${MAX_DEPTH}.`,
    )
  }
  return Math.ceil(depth / RESULTS_PER_PAGE)
}

// An async Google search costs 3 credits, plus 2 for each page after the
// first.
const snapshotCredits = (pages: number) => 3 + 2 * (pages - 1)
// The capability's request budget: one to queue, the rest to read.
const SNAPSHOT_REQUESTS = 20
const POLL_MS = 3_000

const snakeCase = (key: string) =>
  key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`)

function present(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'string') return value.trim().length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return true
}

async function serpSnapshot(
  input: SeoProviderConnection & {
    keyword: string
    market: SeoSearchMarket
    depth: number
  },
  runtime: SeoProviderRuntime,
): Promise<SeoSerpSnapshotResult> {
  const keyword = input.keyword.trim().replace(/\s+/gu, ' ')
  if (!keyword || keyword.length > 1_000) {
    throw failure('configuration', 'Use a keyword of 1 to 1,000 characters.')
  }
  const market = snapshotMarket(input.market)
  const pages = pagesFor(input.depth)
  const [queued] = await queue(input, runtime, 'serp-snapshot:queue', [
    {
      taskType: 'GOOGLE',
      payload: {
        query: keyword,
        country: market.countryCode,
        hl: market.languageCode,
        device: market.device,
        ...(pages > 1 ? { pages } : {}),
      },
    },
  ])
  if (!queued || 'error' in queued) {
    throw failure('remote-error', queued?.error ?? 'cloro queued no task.')
  }
  let task: ReadTask | undefined
  for (let read = 1; read < SNAPSHOT_REQUESTS; read += 1) {
    await sleep(POLL_MS)
    ;[task] = await readTasks(input, runtime, 'serp-snapshot:read', [queued.id])
    if (task?.state !== 'pending') break
  }
  if (task?.state === 'failed') throw failure('remote-error', task.error)
  if (task?.state !== 'done') {
    throw failure(
      'timeout',
      `cloro did not finish the search in time. Task ${queued.id} keeps the result for 24 hours.`,
    )
  }
  const result = task.response
  const observedAt = runtime.now()
  const raw = items(result.organicResults)
  const mapped = raw.flatMap((item): SeoSerpOrganicResult[] => {
    const url = safeUrl(item.link)
    const rank = item.position
    if (!url || typeof rank !== 'number' || !Number.isSafeInteger(rank)) {
      return []
    }
    if (rank < 1) return []
    return [
      {
        rankGroup: rank,
        rankAbsolute: rank,
        page:
          typeof item.page === 'number'
            ? item.page
            : Math.ceil(rank / RESULTS_PER_PAGE),
        domain: hostOf(url) ?? '',
        url,
        title: text(item.title),
        description: text(item.snippet),
        isFeaturedSnippet: null,
      },
    ]
  })
  mapped.sort(
    (left, right) =>
      left.rankAbsolute - right.rankAbsolute ||
      (left.url < right.url ? -1 : left.url > right.url ? 1 : 0),
  )
  const organicResults = mapped.slice(0, input.depth)
  const invalidRows = raw.length - mapped.length
  const credits = snapshotCredits(pages)
  const qualityWarnings: SeoSerpSnapshotResult['qualityWarnings'][number][] = [
    {
      code: 'estimated-monetary-cost',
      field: 'cost.actualMicros',
      message: `cloro charged ${task.credits} credits. Their money value depends on the plan, so the estimate uses the highest paid rate per credit.`,
    },
  ]
  if (invalidRows > 0) {
    qualityWarnings.push({
      code: 'invalid-organic-results',
      field: 'organicResults',
      message: `cloro returned ${invalidRows} organic result${invalidRows === 1 ? '' : 's'} without a valid rank or URL.`,
    })
  }
  return {
    observedAt,
    effectiveKeyword: keyword,
    searchEngineDomain: null,
    checkUrl: null,
    resultCount: null,
    pagesCount: Math.max(0, ...mapped.map((row) => row.page)) || null,
    features: [
      ...new Set(
        Object.entries(result)
          .filter(([key, value]) => key !== 'html' && present(value))
          .map(([key]) =>
            key === 'organicResults' ? 'organic' : snakeCase(key),
          ),
      ),
    ].sort(),
    organicResults,
    localPack: {
      present: false,
      returnedRows: 0,
      retainedRows: 0,
      invalidRows: 0,
      results: [],
    },
    coverage: {
      returnedRows: raw.length,
      retainedRows: organicResults.length,
      invalidRows,
      providerTotalRows: null,
      completeness:
        invalidRows > 0
          ? 'partial'
          : mapped.length > input.depth
            ? 'capped'
            : 'complete',
      nextCursor: null,
    },
    request: {
      endpoint: 'v1/async/task (GOOGLE)',
      filters: {
        countryCode: market.countryCode,
        languageCode: market.languageCode,
        device: market.device,
        pages,
      },
      sort: ['rankAbsolute:ascending', 'url:codepoint-ascending'],
    },
    cost: {
      estimatedMicros: credits * MICROS_PER_CREDIT,
      actualMicros: null,
      taskIds: [queued.id],
      native: {
        unit: 'credit',
        estimatedUnits: credits,
        actualUnits: task.credits,
        remainingBefore: null,
      },
    },
    qualityWarnings,
  }
}

// --- Async tasks (serp and ai-answers actions) -----------------------------

type QueuedTask = {
  taskType: string
  idempotencyKey?: string
  payload: Record<string, unknown>
}

// Queues up to 500 tasks in one request. Each entry is the task id, or why
// cloro refused the task. A task whose idempotency key was used before comes
// back as that earlier task, so a run sent again on the same day does not
// queue or charge twice. cloro charges a task only when it finishes.
async function queue(
  connection: SeoProviderConnection,
  runtime: SeoProviderRuntime,
  operation: string,
  tasks: QueuedTask[],
): Promise<({ id: string } | { error: string })[]> {
  const data = (await runtime.requestJson({
    operation,
    url: `${API}/v1/async/task/batch`,
    method: 'POST',
    headers: headers(connection),
    body: JSON.stringify(tasks),
  })) as Item | null
  const results = items(data?.results)
  return tasks.map((_, index) => {
    const result = results.find((item) => item.index === index)
    const task = result?.task as Item | undefined
    if (result?.success === true && typeof task?.id === 'string') {
      return { id: task.id }
    }
    const error = (result?.error ?? {}) as Item
    const details = (error.details ?? {}) as Item
    if (
      error.code === 'RESOURCE_ALREADY_EXISTS' &&
      typeof details.taskId === 'string'
    ) {
      return { id: details.taskId }
    }
    return {
      error: `cloro: ${text(error.code) ?? 'no task'}${text(error.message) ? `, ${text(error.message)}` : ''}`,
    }
  })
}

type ReadTask =
  | {
      state: 'done'
      id: string
      type: string | null
      key: string | null
      createdAt: string | null
      credits: number
      response: Item
    }
  | {
      state: 'failed'
      id: string
      type: string | null
      key: string | null
      error: string
    }
  | { state: 'pending'; id: string; type: string | null; key: string | null }

const LIMIT_REACHED = /exceeded its request limit/u

// Reads queued tasks one request each, until the host's request limit for
// this run. A task that is not read, or not finished, stays pending.
// Reading a task costs no credits. cloro deletes a task 24 hours after it
// was created.
async function readTasks(
  connection: SeoProviderConnection,
  runtime: SeoProviderRuntime,
  operation: string,
  ids: string[],
): Promise<ReadTask[]> {
  const out: ReadTask[] = []
  let stopped = false
  for (const id of ids) {
    if (stopped) {
      out.push({ state: 'pending', id, type: null, key: null })
      continue
    }
    let data: Item | null
    try {
      data = (await runtime.requestJson({
        operation,
        url: `${API}/v1/async/task/${encodeURIComponent(id)}`,
        headers: headers(connection),
      })) as Item | null
    } catch (error) {
      if (error instanceof Error && LIMIT_REACHED.test(error.message)) {
        stopped = true
        out.push({ state: 'pending', id, type: null, key: null })
        continue
      }
      const status = (error as { status?: unknown }).status
      out.push({
        state: 'failed',
        id,
        type: null,
        key: null,
        error:
          status === 404
            ? 'cloro: the task is gone. cloro keeps a task for 24 hours.'
            : `cloro: ${error instanceof Error ? error.message : String(error)}`.slice(
                0,
                200,
              ),
      })
      continue
    }
    const task = (data?.task ?? {}) as Item
    const status = text(task.status)
    const type = text(task.taskType)
    const key = text(task.idempotencyKey)
    const response = data?.response as Item | undefined
    if (status === 'COMPLETED' && response && typeof response === 'object') {
      const credits = (data?.credits ?? {}) as Item
      out.push({
        state: 'done',
        id,
        type,
        key,
        createdAt: text(task.createdAt),
        credits:
          typeof credits.creditsCharged === 'number'
            ? credits.creditsCharged
            : 0,
        response,
      })
    } else if (status === 'FAILED') {
      const error = (response?.error ?? {}) as Item
      out.push({
        state: 'failed',
        id,
        type,
        key,
        error:
          `cloro: ${text(error.code) ?? 'FAILED'}${text(error.message) ? `, ${text(error.message)}` : ''}`.slice(
            0,
            200,
          ),
      })
    } else {
      out.push({ state: 'pending', id, type, key })
    }
  }
  return out
}

const today = (runtime: SeoProviderRuntime) => runtime.now().slice(0, 10)

function stringList(
  value: SeoProviderJson | undefined,
  name: string,
  max: number,
): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw failure('configuration', `${name} must be a list.`)
  const list = [
    ...new Set(
      value.map((item) => (typeof item === 'string' ? item.trim() : '')),
    ),
  ].filter(Boolean)
  if (list.length > max) {
    throw failure('configuration', `${name} takes up to ${max} values.`)
  }
  return list
}

function waitSeconds(value: SeoProviderJson | undefined, fallback: number) {
  if (value === undefined) return fallback
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 120
  ) {
    throw failure('configuration', 'waitSeconds must be from 0 to 120.')
  }
  return value
}

// --- serp action -------------------------------------------------------------

// The idempotency key carries the keyword, because cloro does not return a
// task's payload: answers read back later still know their keyword. A Bing
// key has its own prefix, so a Google and a Bing search for the same keyword
// are two tasks.
const serpKey = (
  engine: SearchEngineName,
  code: string,
  day: string,
  keyword: string,
) => `${engine === 'google' ? 'seo-serp' : `seo-serp-${engine}`}:${code}:${day}:${keyword}`
const keywordOf = (key: string | null) =>
  key && /^seo-serp(-[a-z]+)?:/u.test(key)
    ? key.split(':').slice(3).join(':')
    : null
const searchEngineOf = (type: string | null): SearchEngineName | null =>
  SEARCH_ENGINE_NAMES.find((name) => SEARCH_ENGINES[name] === type) ?? null

type SerpRow = {
  keyword: string | null
  engine: SearchEngineName | null
  type: 'organic' | 'ai_overview'
  position: number | null
  url: string | null
  domain: string | null
  title: string | null
}

function serpRows(
  keyword: string | null,
  engine: SearchEngineName | null,
  result: Item,
): SerpRow[] {
  const organic = items(result.organicResults).map((item): SerpRow => {
    const url = safeUrl(item.link)
    // Without the page, the displayed link still shows the site.
    const site = /^(?:https?:\/\/)?([^/\s›]+)/u.exec(
      String(item.displayedLink ?? ''),
    )
    return {
      keyword,
      engine,
      type: 'organic',
      position: typeof item.position === 'number' ? item.position : null,
      url,
      domain: url ? hostOf(url) : (site?.[1] ?? null),
      title: text(item.title),
    }
  })
  const overview = (result.aioverview ?? {}) as Item
  const cited = items(overview.sources).map((source): SerpRow => {
    const url = safeUrl(source.url)
    return {
      keyword,
      engine,
      type: 'ai_overview',
      position: typeof source.position === 'number' ? source.position : null,
      url,
      domain: hostOf(url),
      title: text(source.label),
    }
  })
  return [...organic, ...cited]
}

type AdRow = {
  keyword: string | null
  engine: SearchEngineName | null
  type: string | null
  blockPosition: string | null
  position: number | null
  url: string | null
  domain: string | null
  title: string | null
  description: string | null
  price: string | null
  store: string | null
}

// Ads have their own list, so rows keeps the organic results and the AI
// Overview sources only. The domain is the advertiser's, because a Google
// shopping card links to google.com.
function adRows(
  keyword: string | null,
  engine: SearchEngineName | null,
  result: Item,
): AdRow[] {
  return items(result.ads).map((ad): AdRow => ({
    keyword,
    engine,
    type: text(ad.type),
    blockPosition: text(ad.blockPosition),
    position: typeof ad.position === 'number' ? ad.position : null,
    url: safeUrl(ad.url),
    domain: text(ad.domain),
    title: text(ad.title),
    description: text(ad.description),
    price: text(((ad.price ?? {}) as Item).raw),
    store: text(ad.store),
  }))
}

async function serpAction(
  input: SeoProviderConnection & {
    params: Readonly<Record<string, SeoProviderJson>>
  },
  runtime: SeoProviderRuntime,
) {
  const { params } = input
  const given = stringList(params.tasks, 'tasks', 50)
  const errors: { keyword: string | null; task: string | null; error: string }[] =
    []
  let ids: string[]
  let wait = 0
  if (given.length) {
    ids = given
  } else {
    const keywords = stringList(params.keywords, 'keywords', MAX_KEYWORDS)
    if (!keywords.length) {
      throw failure('configuration', 'Give 1 to 5 keywords, or tasks to read.')
    }
    const engine = params.engine ?? 'google'
    if (typeof engine !== 'string' || !(engine in SEARCH_ENGINES)) {
      throw failure(
        'configuration',
        `Unknown engine ${String(engine)}. Use ${SEARCH_ENGINE_NAMES.join(' or ')}.`,
      )
    }
    const searchEngine = engine as SearchEngineName
    const code = country(params.country)
    const day = today(runtime)
    const asks = keywords.filter((keyword) => {
      if (searchEngine === 'bing' && bingPromptLength(keyword) > BING_PROMPT_LIMIT) {
        errors.push({
          keyword,
          task: null,
          error: `Bing takes up to ${BING_PROMPT_LIMIT} characters after URL encoding.`,
        })
        return false
      }
      return true
    })
    const queued = asks.length
      ? await queue(
          input,
          runtime,
          'serp:queue',
          asks.map((keyword) => ({
            taskType: SEARCH_ENGINES[searchEngine],
            idempotencyKey: serpKey(searchEngine, code, day, keyword),
            payload: { query: keyword, country: code, include: { aioverview: true } },
          })),
        )
      : []
    ids = []
    queued.forEach((entry, index) => {
      if ('id' in entry) ids.push(entry.id)
      else errors.push({ keyword: asks[index] ?? null, task: null, error: entry.error })
    })
    wait = waitSeconds(params.waitSeconds, 20)
  }
  if (wait && ids.length) await sleep(wait * 1_000)
  const read = await readTasks(input, runtime, 'serp:read', ids)
  const rows: SerpRow[] = []
  const ads: AdRow[] = []
  const pendingTasks: string[] = []
  let credits = 0
  for (const task of read) {
    if (task.state === 'pending') pendingTasks.push(task.id)
    else if (task.state === 'failed') {
      errors.push({ keyword: keywordOf(task.key), task: task.id, error: task.error })
    } else {
      credits += task.credits
      rows.push(...serpRows(keywordOf(task.key), searchEngineOf(task.type), task.response))
      ads.push(...adRows(keywordOf(task.key), searchEngineOf(task.type), task.response))
    }
  }
  return { rows, ads, credits, pendingTasks, errors }
}

// --- ai-answers action -------------------------------------------------------

const answerKey = (
  engine: string,
  code: string,
  day: string,
  question: string,
) => `seo-ai-answers:${engine}:${code}:${day}:${question}`
const questionOf = (key: string | null) =>
  key?.startsWith('seo-ai-answers:') ? key.split(':').slice(4).join(':') : null
const engineOf = (type: string | null): EngineName | null =>
  ENGINE_NAMES.find((name) => ENGINES[name].type === type) ?? null

// The registrable part of a site: "https://www.example.com/x" -> example.com.
function siteDomain(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  const host = hostOf(/^https?:\/\//u.test(raw) ? raw : `https://${raw}`)
  const domain = host?.replace(/^www\./u, '') ?? ''
  if (!domain.includes('.')) {
    throw failure('configuration', 'Give the site as a domain, such as example.com.')
  }
  return domain
}

function onSite(url: string, domain: string): boolean {
  const host = hostOf(url)
  return !!host && (host === domain || host.endsWith(`.${domain}`))
}

// Hosts that show up in answers without being a source: image hosts, CDNs
// and placeholder domains written into examples.
const NOT_SOURCES = [
  'images.openai.com',
  'gstatic.com',
  'googleusercontent.com',
  'ggpht.com',
  'example.com',
  'example.org',
  'example.net',
]
const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg)(\?|#|$)/iu

function isSource(url: string): boolean {
  const host = hostOf(url)?.replace(/^www\./u, '')
  if (!host || IMAGE.test(url)) return false
  // AI Mode can cite a Google shopping search. It is not a source.
  if (/(^|\.)google\.[a-z.]+$/u.test(host) && new URL(url).pathname === '/search') {
    return false
  }
  return !NOT_SOURCES.some((name) => host === name || host.endsWith(`.${name}`))
}

// The answer's own words: citation pills such as [1](url) or
// [example.com](url) and bare links go, so a citation is never also counted
// as a mention by name.
function prose(markdown: string): string {
  return withoutLinkMarkup(markdown).replace(/https?:\/\/\S+/gu, ' ')
}

// The same result as
//   markdown.replace(/\[([^\]]*)\]\(https?:\/\/[^)]*\)/gu, label or ' ')
// with each character read a fixed number of times. That pattern starts again
// at each "[" and reads to the next "]" and ")", so a crafted answer of a few
// hundred KB took seconds (CodeQL js/polynomial-redos).
function withoutLinkMarkup(markdown: string): string {
  let result = ''
  let copiedTo = 0
  let closeBracket = -1
  let closeParen = -1
  for (let start = markdown.indexOf('['); start !== -1; start = markdown.indexOf('[', start + 1)) {
    if (closeBracket <= start) closeBracket = markdown.indexOf(']', start + 1)
    if (closeBracket === -1) break
    const url = closeBracket + 1
    if (!markdown.startsWith('(http://', url) && !markdown.startsWith('(https://', url)) continue
    if (closeParen <= url) closeParen = markdown.indexOf(')', url)
    if (closeParen === -1) break
    const label = markdown.slice(start + 1, closeBracket)
    result += markdown.slice(copiedTo, start)
    result += /^\s*(\d+|[\w-]+(\.[\w-]+)+)\s*$/u.test(label) ? ' ' : label
    copiedTo = closeParen + 1
    start = closeParen
  }
  return result + markdown.slice(copiedTo)
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

type Verdict = 'cited' | 'mentioned' | 'neither' | 'no_answer'

// What one answer says about the site: cited (a source or a link in the
// text is on the site), mentioned (the text names the site or the brand),
// neither, or no_answer.
export function classify(
  answer: Item,
  site: { domain: string; names: string[] },
): {
  result: Verdict
  citedUrl: string | null
  sources: string[]
  model: string | null
} {
  const markdown = typeof answer.text === 'string' ? answer.text : ''
  // Every source counts. ChatGPT sources carry a footnote flag, but links
  // written into the text came back with it too.
  const given = items(answer.sources)
    .map((source) => safeUrl(source.url))
    .filter((url): url is string => !!url)
  const model = text(answer.model)
  if (!markdown && !given.length) {
    return { result: 'no_answer', citedUrl: null, sources: [], model }
  }
  const linked = markdown.match(/https?:\/\/[^\s)\]]+/gu) ?? []
  const all = [...given, ...linked]
  const citedUrl = all.find((url) => onSite(url, site.domain)) ?? null
  const sources = [
    ...new Set(
      all
        .filter((url) => !onSite(url, site.domain) && isSource(url))
        .map((url) => hostOf(url)?.replace(/^www\./u, ''))
        .filter((host): host is string => !!host),
    ),
  ].slice(0, MAX_SOURCES)
  if (citedUrl) return { result: 'cited', citedUrl, sources, model }
  const words = prose(markdown).toLowerCase()
  const mentioned =
    words.includes(site.domain) ||
    site.names.some((name) =>
      new RegExp(`(^|[^\\p{L}\\p{N}])${escape(name.toLowerCase())}($|[^\\p{L}\\p{N}])`, 'u').test(words),
    )
  return { result: mentioned ? 'mentioned' : 'neither', citedUrl: null, sources, model }
}

type AnswerRow = {
  question: string | null
  engine: EngineName | null
  result: Verdict | 'pending' | 'unavailable'
  citedUrl: string | null
  sources: string[]
  model: string | null
  answeredAt: string | null
  credits: number
  task: string | null
  error: string | null
}

async function aiAnswersAction(
  input: SeoProviderConnection & {
    params: Readonly<Record<string, SeoProviderJson>>
  },
  runtime: SeoProviderRuntime,
) {
  const { params } = input
  const domain = siteDomain(params.domain)
  const brand = stringList(params.brand, 'brand', 5)
  const site = { domain, names: brand.length ? brand : [domain.split('.')[0] ?? domain] }
  const given = stringList(params.tasks, 'tasks', 100)
  const blank = {
    citedUrl: null,
    sources: [],
    model: null,
    answeredAt: null,
    credits: 0,
    task: null,
    error: null,
  }
  const rows: AnswerRow[] = []
  const ids: string[] = []
  // What each task queued in this run asks, for tasks not read yet.
  const asked = new Map<string, { question: string; engine: EngineName }>()
  let wait = 0
  if (given.length) {
    ids.push(...given)
  } else {
    const questions = stringList(params.questions, 'questions', MAX_QUESTIONS)
    if (!questions.length) {
      throw failure('configuration', 'Give 1 to 5 questions, or tasks to read.')
    }
    const engines = params.engines === undefined
      ? ENGINE_NAMES
      : stringList(params.engines, 'engines', ENGINE_NAMES.length).map((name) => {
          if (!(name in ENGINES)) {
            throw failure(
              'configuration',
              `Unknown engine ${name}. Use ${ENGINE_NAMES.join(', ')}.`,
            )
          }
          return name as EngineName
        })
    const code = country(params.country)
    const day = today(runtime)
    const asks: { question: string; engine: EngineName }[] = []
    for (const question of questions) {
      for (const engine of engines) {
        if (engine === 'bing_ai_mode' && bingPromptLength(question) > BING_PROMPT_LIMIT) {
          rows.push({
            question,
            engine,
            result: 'unavailable',
            ...blank,
            error: `Bing AI Mode takes up to ${BING_PROMPT_LIMIT} characters after URL encoding.`,
          })
          continue
        }
        asks.push({ question, engine })
      }
    }
    const queued = asks.length
      ? await queue(
          input,
          runtime,
          'ai-answers:queue',
          asks.map(({ question, engine }) => ({
            taskType: ENGINES[engine].type,
            idempotencyKey: answerKey(engine, code, day, question),
            payload: { prompt: question, country: code },
          })),
        )
      : []
    queued.forEach((entry, index) => {
      const ask = asks[index]
      if (!ask) return
      if ('id' in entry) {
        ids.push(entry.id)
        asked.set(entry.id, ask)
      } else rows.push({ ...ask, result: 'unavailable', ...blank, error: entry.error })
    })
    wait = waitSeconds(params.waitSeconds, 45)
  }
  if (wait && ids.length) await sleep(wait * 1_000)
  for (const task of await readTasks(input, runtime, 'ai-answers:read', ids)) {
    if (task.state === 'pending') {
      rows.push({
        question: questionOf(task.key) ?? asked.get(task.id)?.question ?? null,
        engine: engineOf(task.type) ?? asked.get(task.id)?.engine ?? null,
        result: 'pending',
        ...blank,
        task: task.id,
      })
    } else if (task.state === 'failed') {
      rows.push({
        question: questionOf(task.key),
        engine: engineOf(task.type),
        result: 'unavailable',
        ...blank,
        task: task.id,
        error: task.error,
      })
    } else {
      rows.push({
        question: questionOf(task.key),
        engine: engineOf(task.type),
        ...blank,
        ...classify(task.response, site),
        answeredAt: task.createdAt?.slice(0, 10) ?? null,
        credits: task.credits,
        task: task.id,
      })
    }
  }
  return {
    domain,
    rows,
    credits: rows.reduce((total, row) => total + row.credits, 0),
    pendingTasks: rows.flatMap((row) =>
      row.result === 'pending' && row.task ? [row.task] : [],
    ),
  }
}

// --- Schemas -----------------------------------------------------------------

const nullable = (type: string) => ({ type: [type, 'null'] })
const strings = (maxItems: number, description: string) => ({
  type: 'array',
  items: { type: 'string', minLength: 1, maxLength: 2_000 },
  minItems: 1,
  maxItems,
  description,
})
const commonParams = {
  country: {
    type: 'string',
    pattern: '^[A-Za-z]{2}$',
    description: 'Two-letter country code. Default US.',
  },
  waitSeconds: {
    type: 'integer',
    minimum: 0,
    maximum: 120,
    description: 'Seconds to wait for queued tasks before reading them.',
  },
}

const serp: SeoProviderActionAdapter = {
  id: 'serp',
  description:
    'Google or Bing organic results, ads and the pages the AI Overview cites, for up to 5 keywords. Results not ready come back as pendingTasks: run again with tasks to read them.',
  inputSchema: {
    type: 'object',
    properties: {
      keywords: strings(MAX_KEYWORDS, 'Keywords to search, 1 to 5.'),
      engine: {
        type: 'string',
        enum: SEARCH_ENGINE_NAMES,
        description: 'The search engine: google or bing. Default google.',
      },
      tasks: strings(50, 'Task ids from pendingTasks, to read instead of searching.'),
      ...commonParams,
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      rows: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            keyword: nullable('string'),
            engine: nullable('string'),
            type: { type: 'string', enum: ['organic', 'ai_overview'] },
            position: nullable('number'),
            url: nullable('string'),
            domain: nullable('string'),
            title: nullable('string'),
          },
          required: ['keyword', 'engine', 'type', 'position', 'url', 'domain', 'title'],
        },
      },
      ads: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            keyword: nullable('string'),
            engine: nullable('string'),
            type: nullable('string'),
            blockPosition: nullable('string'),
            position: nullable('number'),
            url: nullable('string'),
            domain: nullable('string'),
            title: nullable('string'),
            description: nullable('string'),
            price: nullable('string'),
            store: nullable('string'),
          },
          required: [
            'keyword',
            'engine',
            'type',
            'blockPosition',
            'position',
            'url',
            'domain',
            'title',
            'description',
            'price',
            'store',
          ],
        },
      },
      credits: { type: 'number' },
      pendingTasks: { type: 'array', items: { type: 'string' } },
      errors: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            keyword: nullable('string'),
            task: nullable('string'),
            error: { type: 'string' },
          },
          required: ['keyword', 'task', 'error'],
        },
      },
    },
    required: ['rows', 'ads', 'credits', 'pendingTasks', 'errors'],
  },
  run: serpAction,
}

const aiAnswers: SeoProviderActionAdapter = {
  id: 'ai-answers',
  description:
    'Ask ChatGPT, Google AI Mode, Gemini and Bing AI Mode up to 5 questions and report if each answer cites the site, mentions it, or neither. Answers not ready come back as pendingTasks.',
  inputSchema: {
    type: 'object',
    properties: {
      domain: {
        type: 'string',
        minLength: 3,
        maxLength: 253,
        description: 'The site to look for, such as example.com.',
      },
      questions: strings(MAX_QUESTIONS, 'Questions to ask, 1 to 5.'),
      engines: {
        type: 'array',
        items: { type: 'string', enum: ENGINE_NAMES },
        minItems: 1,
        maxItems: ENGINE_NAMES.length,
        description: 'Engines to ask. Default all four.',
      },
      brand: strings(
        5,
        'Names that count as a mention. Default the first label of the domain.',
      ),
      tasks: strings(100, 'Task ids from pendingTasks, to read instead of asking.'),
      ...commonParams,
    },
    required: ['domain'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      domain: { type: 'string' },
      rows: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            question: nullable('string'),
            engine: nullable('string'),
            result: {
              type: 'string',
              enum: ['cited', 'mentioned', 'neither', 'no_answer', 'pending', 'unavailable'],
            },
            citedUrl: nullable('string'),
            sources: { type: 'array', items: { type: 'string' } },
            model: nullable('string'),
            answeredAt: nullable('string'),
            credits: { type: 'number' },
            task: nullable('string'),
            error: nullable('string'),
          },
          required: [
            'question',
            'engine',
            'result',
            'citedUrl',
            'sources',
            'model',
            'answeredAt',
            'credits',
            'task',
            'error',
          ],
        },
      },
      credits: { type: 'number' },
      pendingTasks: { type: 'array', items: { type: 'string' } },
    },
    required: ['domain', 'rows', 'credits', 'pendingTasks'],
  },
  run: aiAnswersAction,
}

// --- Registration -----------------------------------------------------------

const activate: SeoProviderActivate = (host) => {
  host.registerProvider({
    id: 'cloro',
    displayName: 'cloro',
    description:
      'Live Google and Bing results, AI Overview sources and answers from ChatGPT, Google AI Mode, Gemini and Bing AI Mode, from cloro.',
    kinds: ['search-results', 'ai-data'],
    connection: {
      fields: [
        {
          id: 'apiKey',
          label: 'API key',
          kind: 'secret',
          required: true,
          envVar: 'SEO_CLORO_API_KEY',
        },
      ],
      verify,
      verificationNotice:
        'The connection check reads the credit balance. It costs no credits.',
    },
    capabilities: [
      {
        id: 'serp-snapshot',
        defaultDepth: 10,
        maxDepth: MAX_DEPTH,
        maxRequests: SNAPSHOT_REQUESTS,
        markets: [
          {
            searchEngines: ['google'],
            devices: ['desktop', 'mobile'],
            location: 'country-only',
          },
        ],
        estimateCostMicros: ({ depth }) =>
          snapshotCredits(pagesFor(depth)) * MICROS_PER_CREDIT,
        // One to queue and, at most, the rest to read.
        estimateRequests: () => SNAPSHOT_REQUESTS,
        run: serpSnapshot,
      },
    ],
    actions: [serp, aiAnswers],
  })
}

export default activate

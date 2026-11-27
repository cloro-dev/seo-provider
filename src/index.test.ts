import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  SeoProviderActionAdapter,
  SeoProviderHost,
  SeoProviderRegistration,
  SeoProviderRequest,
  SeoProviderRuntime,
} from 'seo/provider-sdk'
import { z } from 'zod'
import activate, { classify } from './index.js'

// Payloads are trimmed from live cloro responses (2026-11), with the
// domains changed to example ones.

async function registration(): Promise<SeoProviderRegistration> {
  let provider: SeoProviderRegistration | undefined
  const host: SeoProviderHost = {
    apiVersion: 1,
    registerProvider(value) {
      provider = value
    },
  }
  await activate(host)
  if (!provider) throw new Error('cloro did not register.')
  return provider
}

// A runtime that answers each request with the next reply, like the host:
// a reply with a status throws the way the host throws for that status,
// and the request limit applies.
function runtime(
  replies: ((request: SeoProviderRequest) => unknown)[],
  maxRequests = 8,
): SeoProviderRuntime & { requests: SeoProviderRequest[] } {
  const requests: SeoProviderRequest[] = []
  return {
    requests,
    now: () => '2026-11-09T10:00:00.000Z',
    async requestJson(request) {
      if (requests.length >= maxRequests) {
        throw new Error('cloro exceeded its request limit.')
      }
      requests.push(request)
      const reply = replies[requests.length - 1]
      if (!reply) throw new Error(`No reply for ${request.url}`)
      return reply(request)
    },
  }
}

const connection = { account: {}, credentials: { apiKey: 'fixture-key' } }
const auth = { authorization: 'Bearer fixture-key', 'content-type': 'application/json' }
const goto = 'https://www.google.com/goto?url=CAESZwHEIkXXoe3bD3ea'
const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`

// The host's own rules for a registration (seo 0.17.3, packages/core
// provider-extensions): kebab-case ids, descriptions up to 240 characters,
// and JSON schemas that zod can build, with no object used twice.
function bounded(value: unknown, seen = new WeakSet<object>(), depth = 0): boolean {
  if (depth > 16) return false
  if (value === null || typeof value !== 'object') {
    return typeof value !== 'string' || value.length <= 8_192
  }
  if (seen.has(value)) return false
  seen.add(value)
  return Object.values(value).every((child) => bounded(child, seen, depth + 1))
}

// An action's result, checked against its output schema the way the host
// checks it.
function output(adapter: SeoProviderActionAdapter, value: unknown) {
  return z.fromJSONSchema(adapter.outputSchema as never).parse(value)
}

async function action(name: string): Promise<SeoProviderActionAdapter> {
  const found = (await registration()).actions?.find((item) => item.id === name)
  if (!found) throw new Error(`No ${name} action.`)
  return found
}

test('cloro registers the SERP snapshot and two actions', async () => {
  const provider = await registration()
  assert.equal(provider.id, 'cloro')
  assert.deepEqual(provider.kinds, ['search-results', 'ai-data'])
  assert.deepEqual(provider.capabilities.map((item) => item.id), ['serp-snapshot'])
  assert.deepEqual(provider.actions?.map((item) => item.id), ['serp', 'ai-answers'])
})

test('the registration follows the host rules', async () => {
  const provider = await registration()
  assert.ok(provider.description.length <= 240)
  assert.ok((provider.connection.verificationNotice ?? '').length <= 500)
  for (const adapter of provider.actions ?? []) {
    assert.match(adapter.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
    assert.ok(adapter.description.length <= 240, adapter.id)
    assert.equal(adapter.inputSchema.type, 'object')
    for (const schema of [adapter.inputSchema, adapter.outputSchema]) {
      assert.ok(bounded(schema), adapter.id)
      z.fromJSONSchema(schema as never)
    }
  }
  const input = z.fromJSONSchema((await action('ai-answers')).inputSchema as never)
  assert.ok(input.safeParse({ domain: 'acme.io', questions: ['best crm'] }).success)
  assert.ok(!input.safeParse({ questions: ['best crm'] }).success)
  assert.ok(!input.safeParse({ domain: 'acme.io', engines: ['perplexity'] }).success)
})

test('verify reads the free credit balance', async () => {
  const provider = await registration()
  const run = runtime([() => ({ remaining: 480, perCycle: 500, cycleResetsAt: null })])
  await provider.connection.verify(connection, run)
  assert.deepEqual(run.requests, [
    { operation: 'verify', url: 'https://api.cloro.dev/v1/credits', headers: auth },
  ])
})

test('serp-snapshot queues one Google task and reads it until it finishes', async () => {
  const capability = (await registration()).capabilities[0]
  if (capability?.id !== 'serp-snapshot') throw new Error('No SERP snapshot.')
  assert.equal(
    capability.estimateCostMicros({
      keyword: 'crm software',
      market: { searchEngine: 'google', countryCode: 'US', languageCode: 'en' },
      depth: 20,
    }),
    5 * 800,
  )
  const run = runtime([
    () => ({ success: true, results: [{ success: true, index: 0, task: { id: id(1) } }] }),
    () => ({ task: { id: id(1), taskType: 'GOOGLE', status: 'PROCESSING' } }),
    () => ({
      task: { id: id(1), taskType: 'GOOGLE', status: 'COMPLETED' },
      credits: { creditsToCharge: 5, creditsCharged: 5 },
      response: {
        organicResults: [
          {
            position: 1,
            title: 'What is CRM software?',
            link: 'https://www.example.com/crm/',
            displayedLink: 'https://www.example.com › crm',
            snippet: 'CRM software helps teams ...',
            page: 1,
            redirectLink: goto,
          },
          { position: 2, title: 'No link', link: '', page: 1, redirectLink: goto },
          {
            position: 11,
            title: 'Best CRM',
            link: 'https://crm.example.net/best/',
            page: 2,
          },
        ],
        peopleAlsoAsk: [{ question: 'What is a CRM?' }],
        relatedSearches: [],
      },
    }),
  ])
  const out = await capability.run(
    {
      ...connection,
      keyword: ' crm  software ',
      market: {
        searchEngine: 'google',
        countryCode: 'US',
        languageCode: 'en',
        device: 'mobile',
      },
      depth: 20,
    },
    run,
  )
  assert.deepEqual(run.requests[0]?.body && JSON.parse(run.requests[0].body), [
    {
      taskType: 'GOOGLE',
      payload: { query: 'crm software', country: 'US', hl: 'en', device: 'mobile', pages: 2 },
    },
  ])
  assert.deepEqual(
    run.requests.slice(1).map((request) => request.url),
    [1, 2].map(() => `https://api.cloro.dev/v1/async/task/${id(1)}`),
  )
  assert.deepEqual(
    out.organicResults.map((row) => [row.rankAbsolute, row.page, row.domain, row.url]),
    [
      [1, 1, 'www.example.com', 'https://www.example.com/crm/'],
      [11, 2, 'crm.example.net', 'https://crm.example.net/best/'],
    ],
  )
  assert.deepEqual(out.features, ['organic', 'people_also_ask'])
  assert.equal(out.coverage.invalidRows, 1)
  assert.equal(out.coverage.completeness, 'partial')
  assert.deepEqual(out.cost.taskIds, [id(1)])
  assert.equal(out.cost.native?.estimatedUnits, 5)
  assert.equal(out.cost.native?.actualUnits, 5)
})

test('serp queues one batch, waits, and reads organic and AI Overview rows', async () => {
  const serp = await action('serp')
  const run = runtime([
    () => ({
      success: true,
      results: [
        { success: true, index: 0, task: { id: id(1), status: 'QUEUED' } },
        {
          success: false,
          index: 1,
          error: { code: 'VALIDATION_ERROR', message: 'Invalid task at index 1' },
        },
      ],
    }),
    () => ({
      task: {
        id: id(1),
        taskType: 'GOOGLE',
        status: 'COMPLETED',
        createdAt: '2026-11-09T09:59:00.000Z',
        idempotencyKey: 'seo-serp:US:2026-11-09:best crm',
      },
      credits: { creditsToCharge: 5, creditsCharged: 5 },
      response: {
        organicResults: [
          {
            position: 1,
            title: 'The 12 best CRM tools',
            link: 'https://www.example.com/blog/best-crm/',
            page: 1,
          },
          {
            position: 2,
            title: 'What are the best CRM tools? : r/CRM',
            link: '',
            displayedLink: 'www.example.org',
            page: 1,
            redirectLink: goto,
          },
        ],
        aioverview: {
          text: 'The best CRM tools cater to different needs.',
          sources: [
            { label: 'CRM picks', url: 'https://blog.example.net/crm', position: 1 },
          ],
        },
        ads: [
          {
            position: 1,
            blockPosition: 'top',
            type: 'RESULT',
            title: 'CRM sale',
            url: 'https://shop.example.com/crm',
            page: 1,
            domain: 'shop.example.com',
            description: 'A CRM for small teams.',
          },
          {
            position: 1,
            blockPosition: 'rhs',
            type: 'SHOPPING_CARD',
            title: 'CRM book',
            url: 'https://www.google.com/aclk?sa=L',
            page: 1,
            category: 'Sponsored products',
            price: { value: 29, currency: '$', raw: '$29.00' },
            store: 'Shop',
          },
          {},
        ],
      },
    }),
  ])
  const out = await serp.run(
    { ...connection, params: { keywords: ['best crm', 'x'], waitSeconds: 0 } },
    run,
  )
  output(serp, out)
  assert.deepEqual(JSON.parse(run.requests[0]?.body ?? ''), [
    {
      taskType: 'GOOGLE',
      idempotencyKey: 'seo-serp:US:2026-11-09:best crm',
      payload: { query: 'best crm', country: 'US', include: { aioverview: true } },
    },
    {
      taskType: 'GOOGLE',
      idempotencyKey: 'seo-serp:US:2026-11-09:x',
      payload: { query: 'x', country: 'US', include: { aioverview: true } },
    },
  ])
  assert.equal(run.requests[1]?.url, `https://api.cloro.dev/v1/async/task/${id(1)}`)
  assert.deepEqual(out, {
    rows: [
      {
        keyword: 'best crm',
        engine: 'google',
        type: 'organic',
        position: 1,
        url: 'https://www.example.com/blog/best-crm/',
        domain: 'www.example.com',
        title: 'The 12 best CRM tools',
      },
      {
        keyword: 'best crm',
        engine: 'google',
        type: 'organic',
        position: 2,
        url: null,
        domain: 'www.example.org',
        title: 'What are the best CRM tools? : r/CRM',
      },
      {
        keyword: 'best crm',
        engine: 'google',
        type: 'ai_overview',
        position: 1,
        url: 'https://blog.example.net/crm',
        domain: 'blog.example.net',
        title: 'CRM picks',
      },
    ],
    ads: [
      {
        keyword: 'best crm',
        engine: 'google',
        type: 'RESULT',
        blockPosition: 'top',
        position: 1,
        url: 'https://shop.example.com/crm',
        domain: 'shop.example.com',
        title: 'CRM sale',
        description: 'A CRM for small teams.',
        price: null,
        store: null,
      },
      {
        keyword: 'best crm',
        engine: 'google',
        type: 'SHOPPING_CARD',
        blockPosition: 'rhs',
        position: 1,
        url: 'https://www.google.com/aclk?sa=L',
        domain: null,
        title: 'CRM book',
        description: null,
        price: '$29.00',
        store: 'Shop',
      },
      {
        keyword: 'best crm',
        engine: 'google',
        type: null,
        blockPosition: null,
        position: null,
        url: null,
        domain: null,
        title: null,
        description: null,
        price: null,
        store: null,
      },
    ],
    credits: 5,
    pendingTasks: [],
    errors: [
      { keyword: 'x', task: null, error: 'cloro: VALIDATION_ERROR, Invalid task at index 1' },
    ],
  })
})

test('serp with engine bing queues Bing tasks and refuses a long query', async () => {
  const serp = await action('serp')
  const run = runtime([
    () => ({
      success: true,
      results: [{ success: true, index: 0, task: { id: id(1), status: 'QUEUED' } }],
    }),
    () => ({
      task: {
        id: id(1),
        taskType: 'BING',
        status: 'COMPLETED',
        createdAt: '2026-11-21T09:59:00.000Z',
        idempotencyKey: 'seo-serp-bing:GB:2026-11-09:season a wok',
      },
      credits: { creditsToCharge: 5, creditsCharged: 5 },
      response: {
        organicResults: [
          {
            position: 1,
            title: 'How to Season a Wok',
            link: 'https://www.example.com/season-a-wok/',
            displayedLink: 'https://www.example.com › season-a-wok',
            snippet: 'Heat the wok, then coat it with a thin layer of oil.',
            page: 1,
            date: 'Apr 5, 2024',
          },
        ],
        aioverview: {
          text: 'Seasoning a wok means heating a thin layer of oil until it polymerizes.',
          sources: [{ label: 'Wok guide', url: 'https://blog.example.net/wok', position: 1 }],
        },
        ads: [
          {
            position: 1,
            blockPosition: 'rhs',
            type: 'SHOPPING_CARD',
            title: '14 in Wok',
            url: 'https://shop.example.com/wok-14',
            page: 1,
            price: { value: 29, currency: '$', raw: '$29.00' },
            store: 'Shop',
          },
        ],
      },
    }),
  ])
  const long = '中'.repeat(600)
  const out = (await serp.run(
    {
      ...connection,
      params: { keywords: ['season a wok', long], engine: 'bing', country: 'gb', waitSeconds: 0 },
    },
    run,
  )) as {
    rows: Record<string, unknown>[]
    ads: Record<string, unknown>[]
    errors: unknown[]
  }
  output(serp, out)
  assert.deepEqual(
    out.ads.map((ad) => [ad.keyword, ad.engine, ad.type, ad.price, ad.store]),
    [['season a wok', 'bing', 'SHOPPING_CARD', '$29.00', 'Shop']],
  )
  assert.deepEqual(JSON.parse(run.requests[0]?.body ?? ''), [
    {
      taskType: 'BING',
      idempotencyKey: 'seo-serp-bing:GB:2026-11-09:season a wok',
      payload: { query: 'season a wok', country: 'GB', include: { aioverview: true } },
    },
  ])
  assert.deepEqual(
    out.rows.map((row) => [row.keyword, row.engine, row.type, row.domain]),
    [
      ['season a wok', 'bing', 'organic', 'www.example.com'],
      ['season a wok', 'bing', 'ai_overview', 'blog.example.net'],
    ],
  )
  assert.deepEqual(out.errors, [
    {
      keyword: long,
      task: null,
      error: 'Bing takes up to 3500 characters after URL encoding.',
    },
  ])
})

test('serp returns no ads when the page has none', async () => {
  const serp = await action('serp')
  const run = runtime([
    () => ({
      task: { id: id(1), taskType: 'BING', status: 'COMPLETED' },
      response: { organicResults: [] },
    }),
  ])
  const out = await serp.run({ ...connection, params: { tasks: [id(1)] } }, run)
  output(serp, out)
  assert.deepEqual(out, { rows: [], ads: [], credits: 0, pendingTasks: [], errors: [] })
})

test('serp refuses an unknown engine', async () => {
  const serp = await action('serp')
  await assert.rejects(
    serp.run({ ...connection, params: { keywords: ['x'], engine: 'yahoo' } }, runtime([])),
    /Unknown engine yahoo/u,
  )
})

test('ai-answers queues every engine and returns what is not ready as pending', async () => {
  const aiAnswers = await action('ai-answers')
  const run = runtime(
    [
      () => ({
        success: true,
        results: [
          { success: true, index: 0, task: { id: id(1) } },
          {
            // A run sent again: cloro returns the task it already has.
            success: false,
            index: 1,
            error: {
              code: 'RESOURCE_ALREADY_EXISTS',
              message: 'Idempotency key already used',
              details: { taskId: id(2) },
            },
          },
          { success: true, index: 2, task: { id: id(3) } },
          { success: true, index: 3, task: { id: id(4) } },
        ],
      }),
      () => ({
        task: {
          id: id(1),
          taskType: 'CHATGPT',
          status: 'PROCESSING',
          idempotencyKey: 'seo-ai-answers:chatgpt:US:2026-11-09:what is the best crm',
        },
        credits: { creditsToCharge: 5, creditsCharged: null },
      }),
    ],
    // One batch and one read: the host's limit stops the rest.
    2,
  )
  const out = (await aiAnswers.run(
    {
      ...connection,
      params: { domain: 'example.com', questions: ['what is the best crm'], waitSeconds: 0 },
    },
    run,
  )) as { rows: Record<string, unknown>[]; pendingTasks: string[]; credits: number }
  output(aiAnswers, out)
  assert.deepEqual(
    JSON.parse(run.requests[0]?.body ?? '').map((task: { taskType: string; idempotencyKey: string }) => [
      task.taskType,
      task.idempotencyKey,
    ]),
    [
      ['CHATGPT', 'seo-ai-answers:chatgpt:US:2026-11-09:what is the best crm'],
      ['AIMODE', 'seo-ai-answers:google_ai_mode:US:2026-11-09:what is the best crm'],
      ['GEMINI', 'seo-ai-answers:gemini:US:2026-11-09:what is the best crm'],
      ['BING_AIMODE', 'seo-ai-answers:bing_ai_mode:US:2026-11-09:what is the best crm'],
    ],
  )
  assert.deepEqual(out.pendingTasks, [id(1), id(2), id(3), id(4)])
  assert.deepEqual(
    out.rows.map((row) => [row.engine, row.result]),
    [
      ['chatgpt', 'pending'],
      ['google_ai_mode', 'pending'],
      ['gemini', 'pending'],
      ['bing_ai_mode', 'pending'],
    ],
  )
  assert.equal(out.credits, 0)
})

test('ai-answers reads tasks back and judges each finished answer', async () => {
  const aiAnswers = await action('ai-answers')
  const key = (engine: string) =>
    `seo-ai-answers:${engine}:US:2026-11-05:what is the best crm`
  const finished = (n: number, taskType: string, engine: string, charged: number, response: unknown) => () => ({
    task: {
      id: id(n),
      taskType,
      status: 'COMPLETED',
      createdAt: '2026-11-05T21:41:18.033Z',
      idempotencyKey: key(engine),
    },
    credits: { creditsToCharge: charged, creditsCharged: charged },
    response,
  })
  const run = runtime([
    finished(1, 'CHATGPT', 'chatgpt', 5, {
      // Live ChatGPT answers can report no model.
      model: null,
      text: 'Here are my top picks.\n\n1. Acme CRM\n\nWebsite and pricing',
      sources: [
        { position: 1, label: 'Website and pricing', url: 'https://www.acme.io/pricing', footnote: true },
        { position: 2, label: 'CRM picks', url: 'https://crm.picks.test/top/', footnote: false },
      ],
    }),
    finished(2, 'AIMODE', 'google_ai_mode', 4, {
      text: 'Acme CRM suits small teams.',
      sources: [
        { position: 1, url: 'https://reviews.test/crm/' },
        { position: 2, url: 'https://www.google.com/search?q=crm&udm=28' },
      ],
    }),
    finished(3, 'GEMINI', 'gemini', 4, {
      text: 'Try a spreadsheet first. Acmeville has one.',
      sources: [{ position: 1, url: 'https://sheets.test/#:~:text=Free%20plan' }],
    }),
    () => ({
      task: {
        id: id(4),
        taskType: 'BING_AIMODE',
        status: 'FAILED',
        idempotencyKey: key('bing_ai_mode'),
      },
      response: { error: { code: 'MODEL_ERROR', message: 'No answer after 5 attempts' } },
    }),
    () => {
      // cloro deletes a task 24 hours after it was created.
      throw Object.assign(new Error('cloro returned HTTP 404.'), { status: 404 })
    },
  ])
  const out = (await aiAnswers.run(
    {
      ...connection,
      params: { domain: 'https://www.acme.io/', tasks: [id(1), id(2), id(3), id(4), id(5)] },
    },
    run,
  )) as { rows: Record<string, unknown>[]; pendingTasks: string[]; credits: number }
  output(aiAnswers, out)
  assert.equal(run.requests.length, 5)
  assert.ok(run.requests.every((request) => request.method === undefined))
  assert.equal(out.credits, 13)
  assert.deepEqual(out.pendingTasks, [])
  assert.deepEqual(
    out.rows.map((row) => [row.engine, row.result, row.citedUrl, row.sources, row.answeredAt]),
    [
      ['chatgpt', 'cited', 'https://www.acme.io/pricing', ['crm.picks.test'], '2026-11-05'],
      ['google_ai_mode', 'mentioned', null, ['reviews.test'], '2026-11-05'],
      ['gemini', 'neither', null, ['sheets.test'], '2026-11-05'],
      ['bing_ai_mode', 'unavailable', null, [], null],
      [null, 'unavailable', null, [], null],
    ],
  )
  assert.equal(out.rows[0]?.question, 'what is the best crm')
  assert.equal(out.rows[3]?.error, 'cloro: MODEL_ERROR, No answer after 5 attempts')
  assert.match(String(out.rows[4]?.error), /24 hours/u)
})

test('ai-answers refuses a Bing prompt over the limit before it queues', async () => {
  const aiAnswers = await action('ai-answers')
  const run = runtime([])
  const out = (await aiAnswers.run(
    {
      ...connection,
      params: {
        domain: 'acme.io',
        questions: ['é'.repeat(600)],
        engines: ['bing_ai_mode'],
        waitSeconds: 0,
      },
    },
    run,
  )) as { rows: Record<string, unknown>[] }
  assert.equal(run.requests.length, 0)
  assert.deepEqual(out.rows.map((row) => [row.engine, row.result]), [['bing_ai_mode', 'unavailable']])
})

// Answers made to slow down the citation pattern of prose() (CodeQL
// js/polynomial-redos). Before the fix, 440 KB of "[" took 62 s.
test('a crafted answer of 300 KB is classified in less than one second', () => {
  for (const unit of ['[', '[\\', '[a](http://', '](https://', '[example.com](https://']) {
    const text = unit.repeat(Math.ceil(300_000 / unit.length))
    const start = performance.now()
    classify({ text, sources: [] }, { domain: 'example.org', names: ['Example'] })
    const ms = performance.now() - start
    assert.ok(ms < 1000, `${JSON.stringify(unit)} took ${Math.round(ms)} ms`)
  }
})

test('prose() keeps the labels of named links and removes citation pills', () => {
  const answer = {
    text: 'See [Example Tools](https://tools.example.net/x) and [1](https://a.example.com) or [example.com](https://example.com/p).',
    sources: [],
  }
  assert.equal(classify(answer, { domain: 'acme.org', names: ['Example Tools'] }).result, 'mentioned')
  assert.equal(classify(answer, { domain: 'acme.org', names: ['example.com'] }).result, 'neither')
})

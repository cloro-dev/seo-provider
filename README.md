# cloro provider for seo

Adds [cloro](https://cloro.dev/?utm_source=seo-provider&utm_medium=byok) to
[`seo`](https://github.com/iannuttall/seo), the SEO command line tool and MCP
server. With your own cloro API key, `seo` gets:

- live Google results for `seo research serp`,
- Google or Bing organic results with the pages the AI Overview cites,
- answers from ChatGPT, Google AI Mode, Gemini and Bing AI Mode, with a check
  of whether each answer cites your site, mentions it, or neither.

The package runs only on your machine, in the `seo` CLI and the local MCP
server (`seo mcp serve`). It has no runtime dependencies and sends every
request through `seo`, which keeps the key and limits the requests.

## Requirements

- Node.js 22.19 or newer
- `seo` 0.17.3 or newer: `npm install --global seo`
- A cloro API key. The Free plan has 500 credits a month:
  [sign up](https://dashboard.cloro.dev/api-keys?utm_source=seo-provider&utm_medium=byok).

## Install and connect

```sh
seo providers install @cloro-dev/seo-provider
seo providers connect cloro
```

`seo providers connect` asks for the API key and stores it. You can also set
`SEO_CLORO_API_KEY` in the environment. The connection check reads your credit
balance and costs no credits.

## Live Google results

```sh
seo research serp --provider cloro --keywords "crm software,best crm"
```

This uses the `serp-snapshot` capability: one Google search per keyword, by
country, language and device (desktop or mobile), up to 100 results. It
queues the search on cloro's async API and reads it until it finishes, up to
about a minute.

## Actions

Run an action with `seo providers run cloro <action> --params '<json>'`.
Agents run them through `seo_describe_provider` and `seo_run_provider` in the
local MCP server.

### serp

Google or Bing organic results and the pages the AI Overview cites, for up
to 5 keywords.

```sh
seo providers run cloro serp --params '{"keywords":["best crm for startups"],"country":"US"}'
seo providers run cloro serp --params '{"keywords":["best crm for startups"],"engine":"bing"}'
```

Each row has `keyword`, `engine` (`google` or `bing`), `type` (`organic` or
`ai_overview`), `position`, `url`, `domain` and `title`.

Set `engine` to `bing` for Bing Search (default `google`). The country sets
the Bing market. Bing accepts all countries except CN, KR and RU, and a
keyword of up to 3,500 characters after URL encoding. A longer keyword comes
back in `errors` and is not sent.

`seo research serp` asks providers for Google results only, so Bing results
are available through the `serp` action.

### ai-answers

Asks up to 5 questions on each engine and reports, for each answer, whether
it cites the site (`cited`), names it (`mentioned`), or `neither`.

```sh
seo providers run cloro ai-answers --params '{"domain":"example.com","questions":["what is the best crm for startups"]}'
```

| Parameter | What it does |
| --- | --- |
| `domain` | The site to look for. Required. |
| `questions` | 1 to 5 questions. |
| `engines` | Any of `chatgpt`, `google_ai_mode`, `gemini`, `bing_ai_mode`. Default all four. |
| `brand` | Names that count as a mention. Default the first part of the domain. |
| `country` | Two-letter country code. Default `US`. |
| `waitSeconds` | Seconds to wait before reading the answers. Default 45 (20 for `serp`). |
| `tasks` | Task ids to read, instead of asking again. |

Each row has the `question`, the `engine`, the `result`, the cited URL, up to
8 other cited sites, the date of the answer and the credits it cost.

### Answers that are not ready

`serp` and `ai-answers` use cloro's async API. An AI answer can take one to
three minutes, and `seo` allows 8 requests for each run. An answer that is not
ready, or not read in this run, comes back with result `pending`, and its task
id is in `pendingTasks`. Read it later at no cost:

```sh
seo providers run cloro ai-answers --params '{"domain":"example.com","tasks":["<task id>"]}'
```

cloro keeps a task for 24 hours. A run sent again on the same day with the
same question gets the same tasks back and is not charged again. `credits`
in the result is what cloro charged for the tasks in that result.

## Credits

| Request | Credits |
| --- | --- |
| Google search (`serp-snapshot`) | 3, plus 2 for each page after the first |
| Google or Bing search with AI Overview (`serp`) | 5 |
| ChatGPT answer | 5 |
| Google AI Mode, Gemini or Bing AI Mode answer | 4 |

cloro charges a request only when it succeeds. Plans and prices:
[cloro.dev/pricing](https://cloro.dev/pricing/?utm_source=seo-provider&utm_medium=byok).
The cost estimate that `seo` shows uses the highest paid rate per credit
(Lite plan), so larger plans pay less than the estimate.

## Development

```sh
npm install
npm run build
npm run typecheck
npm test
```

The tests use payloads trimmed from live cloro responses.

## License

MIT

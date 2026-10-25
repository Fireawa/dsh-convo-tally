# dsh-convo-tally

**Per-conversation cost readout for the DSH sidebar.** Two numbers that answer one question: *how much has this conversation cost?*

[![CI](https://github.com/Fireawa/dsh-convo-tally/actions/workflows/ci.yml/badge.svg)](https://github.com/Fireawa/dsh-convo-tally/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/Fireawa/dsh-convo-tally)](https://github.com/Fireawa/dsh-convo-tally/releases)

![Sidebar widget: reset button, currency toggle, today and total amounts, peak/off-peak badge](https://raw.githubusercontent.com/Fireawa/dsh-convo-tally/main/docs/screenshot.png)

[中文](README.md) · [Changelog](CHANGELOG.md) · [License](#license)

---

## Features

- **Today / total for the current conversation only** — not a global bill.
- **Peak / off-peak badge** — which rate applies right now, and when it flips.
- **CNY ⇄ USD toggle** — each currency uses DeepSeek's own official price table; **no exchange-rate conversion**.
- **One-click reset of the total** — display only, this conversation only; "today" is left untouched.
- **Always two decimals**.
- No network calls, no telemetry, no credential access.

## Install

Requires **Node.js 20+** (see `engines` in `package.json`) and a working DSH installation.

**GitHub only for now** — the npm package is not published yet.

Latest:

```bash
dsh plugin --profile web add github:Fireawa/dsh-convo-tally
```

Pin a version (recommended, so future changes on `main` cannot surprise you):

```bash
dsh plugin --profile web add github:Fireawa/dsh-convo-tally#v0.1.0
```

Offline: grab `dsh-convo-tally-0.1.0.tgz` from [Releases](https://github.com/Fireawa/dsh-convo-tally/releases) and point the command at the file:

```bash
dsh plugin --profile web add ./dsh-convo-tally-0.1.0.tgz
```

Local development (picks up edits immediately):

```bash
git clone https://github.com/Fireawa/dsh-convo-tally.git
cd dsh-convo-tally
npm install
dsh plugin --profile web add link:$PWD
```

Then **hard-reload the page** (Ctrl/Cmd+F5). Host-side changes need a `dsh web` restart.

Remove with `dsh plugin --profile web remove dsh-convo-tally`.

## Pricing

Two conventions up front:

- **"Today" rolls over at midnight Beijing time (UTC+8)**, not your local timezone.
- **Settlement happens once per model call**, so the number steps rather than ticking per token.

### Rates (per 1M tokens, ¥ / $)

| Model | Tier | Cache hit | Cache miss | Output |
| --- | --- | --- | --- | --- |
| deepseek-flash | off-peak | 0.02 / 0.003 | 1 / 0.15 | 4 / 0.6 |
| deepseek-flash | peak | 0.04 / 0.006 | 2 / 0.3 | 8 / 1.2 |
| deepseek-v4-pro | off-peak | 0.15 / 0.022 | 4.5 / 0.66 | 13.5 / 1.98 |
| deepseek-v4-pro | peak | 0.3 / 0.044 | 9 / 1.32 | 27 / 3.96 |

Taken from DeepSeek's official pricing pages (verified 2026-10). Historical tiers are also built in, so older conversations are priced with the rates that applied then.

### Formula

```
cost = (uncached_input × miss_rate
      + cache_read     × hit_rate
      + cache_write    × hit_rate
      + output         × output_rate) / 1_000_000
```

- The host's `inputTokens` **already excludes** cache hits; it is mutually exclusive with `cacheReadTokens`. Adding the two then applying one rate would over-bill by an order of magnitude.
- `reasoning` tokens are reported separately and **not billed**, so they stay out of the formula.
- The official table has no cache-write rate; it is priced at the hit rate (that bucket was always 0 across 19,000+ real records).

### Peak hours

- Peak: **Mon–Fri 09:00–12:00 and 14:00–18:00 Beijing time**.
- Everything else — including **weekends** and **Chinese public holidays**, all day — is off-peak. Off-peak is half the peak rate.
- The tier is chosen by **each request's start time**, not by "now" or by when the stream finished.

## Design notes

### Why an invisible probe

`sidebar.footer.action` is a **root-scoped** slot: the framework only hands it `{ wide }`, so the sidebar cannot see the current session and therefore cannot use `useProjection`.

So the plugin registers a render-nothing probe on the session-scoped `conversation.composer.dock`. The probe receives the framework-bound projection for whichever conversation is open and copies it into a module-level variable that the sidebar reads. Switching conversations re-renders the probe and the sidebar follows.

**A "most recently active session" heuristic does not work**: it displays a number, but that number does not change when you switch conversations — a bug this project already fixed.

### Why two price tables

The official CNY and USD pages are **not** uniform conversions of one another: flash embeds a ratio of 6.667, pro embeds 6.818. Converting one table by a single rate is necessarily wrong for one currency, so both are computed independently and the toggle only changes which is displayed.

### Fold semantics

Wrong totals usually come from wrong folding, not wrong arithmetic. This mirrors the host's own `tokenUsage` projection:

| Rule | Why |
| --- | --- |
| A newer settlement for the same turn/step **replaces** the old one | Streaming reports usage several times; summing doubles it |
| Identical buckets for the same turn/step **short-circuit** | Replaying a log must be idempotent |
| Only `llm/retry-started` opens a new slot | A retry is a real second request |
| Skip the fork-inherited prefix | The parent session already paid for it |
| Model comes from `request/header` | `assistant/message` carries usage but no model |

## Tests

```bash
npm test        # three offline suites: pricing/fold, client rendering, schedule consistency
npm run check   # syntax checks + tests
```

The offline suites do not need DSH. CI runs them on Node 20 and 22.

## Layout

```
lib/index.js       host: registers the convoCost session projection (fold + dual-currency pricing)
lib/pricing.js     official price tables, peak-window logic, cost math (pure functions)
lib/client.js      browser: the probe, the sidebar widget, the two buttons
test/              selftest / client-selftest / consistency
```

## Feedback

- Bugs, wrong amounts, or suggestions: **[open an issue](https://github.com/Fireawa/dsh-convo-tally/issues)**.
- Please include:
  - your DSH version and the plugin version (release tag, or `npm ls dsh-convo-tally`);
  - the amount shown in the sidebar vs. the official bill, when the number looks wrong;
  - steps to reproduce: when it started, whether you switched currency or reset.
- Issues are the main channel; pull requests are not guaranteed to be merged.

## License

[MIT](LICENSE)

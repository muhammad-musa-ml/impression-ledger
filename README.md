# impression-ledger

Viewable-impression counting for streaming text ads, and ingestion of ad events into PostgreSQL, tested against retries, duplicates and a killed server process.

A streamed ad is still being written while the reader looks at it, so "one second in view" needs a starting point. The counter takes that starting point as a setting and reports both readings: the clock starts at the first token, or at the last one. The service stores the raw events behind every count, so a different rule can be applied to traffic that is already stored.

All events in this repository are synthetic. Nothing here is certified or accredited, and I have not run it against a real browser or real traffic. The limits are listed at the end.

## Run

Requires Docker Compose and Node 22 or later.

```sh
docker compose up -d --wait
npm ci
npm run build
npm run build:web
DATABASE_URL=postgres://ledger:local-development-only@127.0.0.1:55437/ledger AUTO_MIGRATE=1 npm start
```

In a second terminal, send a synthetic stream and open the report page:

```sh
npm run seed-demo
```

Then open http://127.0.0.1:8787/. The server binds to localhost only. The Compose file starts PostgreSQL 17 on 127.0.0.1:55437 with its data on tmpfs, so nothing survives `docker compose down`. The credentials and the two demo API keys (`local-demo-key-alpha-000001` and `local-demo-key-bravo-000002`) are for local use. Set `TENANT_KEYS` to a JSON object of key to tenant to use your own. In PowerShell, set the two variables on their own lines first (`$env:DATABASE_URL = '...'`).

## What is counted

A view is one showing of one ad. The client sends `first_token`, `render_complete`, `visibility` (the fraction of the ad inside the viewport) and `view_end` events with times in milliseconds since the view started. A view counts when the ad is at or above the visibility threshold for the minimum time without a break. Defaults: 0.5 of the ad for 1000 ms, both inclusive (`VIEWABLE_THRESHOLD`, `VIEWABLE_MIN_MS`).

Two timer starts are evaluated for every view and the report shows both:

| strategy | the clock starts at |
| --- | --- |
| `first-token` | the first `first_token` event |
| `fully-rendered` | the first `render_complete` event |

Time in view before the timer start is not credited, and a view whose timer-start event never arrives (a cancelled stream has no `render_complete`) is not counted under that strategy.

What is deliberately not counted or claimed:

- A visible stretch is never extended past the view's last event. If the client goes quiet while the ad is in view, the counter does not assume it stayed there.
- A break below the threshold ends the stretch, and the next one starts from zero.
- There is no pixel measurement, no check that the tab was in focus, no bot or invalid-traffic filtering, and no deduplication across devices. The client reports a fraction and the counter believes it.
- This is not MRC-accredited, and I do not claim it meets the MRC guideline or any other standard. See [design notes](docs/design.md) for where the rule comes from.
- Reading time is not modelled. A one-sentence ad and a ten-line ad are held to the same rule.

## Features

- A pure counter (`src/viewability.ts`) with the timer start as an explicit strategy, checked against a second, millisecond-by-millisecond implementation of the rule that shares no code with it.
- Tenant-scoped bearer keys and a tenant-scoped idempotency key: the primary key of `events` is `(tenant_id, event_id)` and the insert is `ON CONFLICT DO NOTHING`.
- An event id that comes back with different content is reported as a conflict, and the first version stays.
- One transaction per batch: events and the verdicts of the views they touch commit together. Views are locked in id order, so concurrent batches of the same view run one after the other, and a test and the drill both require zero deadlock retries.
- Raw events are kept as received. `npm run recompute` rebuilds the verdicts after a threshold or duration changes.
- A fault drill that kills the server with SIGKILL before and after COMMIT and checks the database against the generator that produced the events.
- A mutation check that puts one defect at a time into a copy of the code and reports which test suite noticed.
- A report endpoint and a small React page with counted impressions per ad under each strategy.

## API

| Method | Path | Behavior |
| --- | --- | --- |
| POST | `/v1/events` | 1 to 500 events for the key's tenant. 200 with `accepted`, `duplicates`, `conflicts`, `rejected`, `retries` |
| GET | `/v1/report` | Counted impressions per ad for the key's tenant, under each strategy |
| GET | `/healthz` | Process liveness |
| GET | `/readyz` | Database connectivity |

```sh
curl -s http://127.0.0.1:8787/v1/events \
  -H 'Authorization: Bearer local-demo-key-alpha-000001' \
  -H 'Content-Type: application/json' \
  -d '{"events":[
        {"eventId":"v1.0","viewId":"v1","adId":"ad-01","type":"first_token","tsMs":100,"seq":0},
        {"eventId":"v1.1","viewId":"v1","adId":"ad-01","type":"visibility","tsMs":100,"seq":1,"visibleFraction":1},
        {"eventId":"v1.2","viewId":"v1","adId":"ad-01","type":"view_end","tsMs":1500,"seq":2}]}'
```

Sending the same body again answers `"accepted":0,"duplicates":3`. A client sends again until it gets a 200; a request that was cut off by a crash is safe to repeat. Bad requests get an `error` object with a `code` and a `message`, and status 400, 401, 405 (with an `Allow` header), 413 or 415. An event that names a different ad than its view already has is listed under `rejected` and not stored.

## Tests

```sh
npm run typecheck
npm test
npm run build
npm run drill -- --runs 1 --seed 7
node dist/scripts/mutation-check.js
```

`npm test` needs the PostgreSQL from `docker compose up -d --wait`. Without a database the database tests skip; `REQUIRE_DB=1` makes them fail instead, and CI sets it. The suites cover the rule at its boundaries, property tests of the counter against the reference (any order, repeated events, monotonicity, the two timer starts), the generated scenarios against their designed outcomes, idempotency and tenant scope, 24 identical batches at once, batches of the same views in opposite orders, a transaction that never reaches COMMIT, recompute, the checker's own ability to notice a lost or doubled event, the HTTP API, and the report table.

`FC_RUNS=<n>` raises the run count of every property to at least n, and `FC_SEED=<n>` fixes their random seed.

The property tests found a real bug in the counter: a visibility sample that was replaced at the same millisecond still ended the stretch it interrupted. It is fixed in `507e48d`, and the input that exposed it is a unit test.

## Architecture

```mermaid
flowchart LR
  Client -->|POST batch, resent until 200| API[Node API]
  API -->|one transaction per batch| PG[(PostgreSQL: events, ad_views, view_results)]
  PG -->|raw events| Counter[viewability.evaluate]
  Counter -->|verdict per strategy| PG
  Reader -->|GET /v1/report| API
```

`events` is the source of truth, `ad_views` holds one row per view and is the row ingestion locks, and `view_results` is derived. See [design notes](docs/design.md).

## Results

Everything below comes from runs on one machine: 24 logical CPUs, Windows 11, Node 22.17.0, PostgreSQL 17.11 in a Docker container. Other containers and programs were running the whole time. These are correctness runs, not speed measurements; I did not measure throughput or latency.

### Fault drill

`node dist/scripts/fault-drill.js --runs 5 --seed 101`, run at commit `0221f18` with a clean tree. Each run is a fresh database with two tenants of 800 views each, batches of 100 events, 8 requests in flight, a quarter of the events delivered twice and a tenth of the batches sent again, in random order. A transaction is held 80 ms before COMMIT and a reply 80 ms after it, so a SIGKILL lands inside those windows. Six kills per run, alternating, each followed by a restart. A number in brackets is how many of those kills had the matching line in the server's own log at the moment the signal was sent: an open transaction before COMMIT, a commit after it.

| run | seed | distinct events | deliveries | kills before COMMIT | kills after COMMIT | failed attempts | committed under a lost reply | events stored | gaps / extra / duplicate rows | verdict mismatches | probes, rows stored right after the kill (before / after COMMIT) | result | file |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 101 | 25397 | 35183 | 3 (3) | 3 (3) | 184 | 443 | 25397 | 0 / 0 / 0 | 0 | 0 of 97 / 97 of 97 | pass | `results/fault-drill/run-01.json` |
| 2 | 102 | 25709 | 35517 | 3 (3) | 3 (3) | 172 | 474 | 25709 | 0 / 0 / 0 | 0 | 0 of 92 / 92 of 92 | pass | `run-02.json` |
| 3 | 103 | 25556 | 37052 | 3 (3) | 3 (3) | 192 | 636 | 25556 | 0 / 0 / 0 | 0 | 0 of 87 / 87 of 87 | pass | `run-03.json` |
| 4 | 104 | 25507 | 34385 | 3 (3) | 3 (3) | 184 | 501 | 25507 | 0 / 0 / 0 | 0 | 0 of 95 / 95 of 95 | pass | `run-04.json` |
| 5 | 105 | 25806 | 35776 | 3 (3) | 3 (3) | 195 | 368 | 25806 | 0 / 0 / 0 | 0 | 0 of 101 / 101 of 101 | pass | `run-05.json` |

`results/fault-drill/SUMMARY.md` has the same table, generated from the run files, and the column definitions.

A run passes only if every one of these holds: each sent event is stored once (no gaps, nothing extra, no event stored twice under two ids); every stored verdict equals the outcome written into the scenario that generated the view, and equals a fresh evaluation of the stored events; the report endpoint's per-ad numbers equal the designed ones; no batch had to retry after a deadlock; the server never exited on its own; and the two probes behave. The probes kill the server with a batch in flight. Before COMMIT, nothing of the batch is stored after the kill, the resend stores it all, and a second resend stores nothing. After COMMIT, the whole batch is stored although the client never heard back, and the resend is answered as all duplicates.

"Committed under a lost reply" counts events whose first successful write was in a request the client never saw answered. They were stored once, and the resend was answered as duplicates.

What the drill sends is known in advance, so "correct" does not depend on the counter under test. The scenarios and their written-down outcomes are in `src/synthetic.ts`.

### Counted impressions

Each run record also holds what `GET /v1/report` returned after the replay, summed over the two tenants (see `SUMMARY.md`). In run 1, 1600 views: 981 counted under `first-token`, 566 under `fully-rendered`, and 415 views are ones the two rules disagree about by design. The scenario mix is my own choice, so those proportions say nothing about real traffic.

For one tenant after `npm run seed-demo` on a fresh database: 300 views, 170 counted under `first-token` and 102 under `fully-rendered` (`results/demo-report-alpha.json`).

### Mutation check

`node dist/scripts/mutation-check.js` copies the repository, puts one defect at a time into the copy, and runs the unit tests, the database tests and a small drill until one fails. At commit `0221f18` it caught all 14. The unbroken copy passed all three first, and the database tests then passed 10 more times in a row on it. Full table with the failing test names: `results/mutation-checks.md`; raw rows: `results/mutation-checks.json`.

| id | defect | caught by |
| --- | --- | --- |
| V1 | the threshold is exclusive | unit tests |
| V2 | the duration is exclusive | unit tests |
| V3 | time in view before the timer start is credited | unit tests |
| V4 | a break below the threshold does not end the stretch | unit tests |
| V5 | events are not sorted | unit tests |
| V6 | a sample replaced at the same instant still ends the stretch | unit tests |
| V7 | at equal time and sequence number the higher fraction wins | unit tests |
| I1 | the view rows are not locked | database tests, 10 of 10 further runs |
| I2 | view rows are created out of id order | database tests, 10 of 10 further runs |
| I3 | no transaction | database tests |
| I4 | no `ON CONFLICT` on the event insert | database tests |
| I5 | the idempotency key is not tenant-scoped | database tests |
| I6 | an id with different content counts as a duplicate | database tests |
| I7 | the verdict uses only the batch's events, not all stored ones | database tests |

I1 and I2 can only be seen when two batches of the same views actually overlap in time. The check runs the database tests 10 more times under each, and each time they failed. That is 10 samples, so it says the catch is not rare, and not that it is certain.

## Open questions

The first is the one this repository is built around. The second is from the first article under Background reading.

1. When does the one-second clock start for an ad that is still being written? The MRC guideline I read measures the second "post ad render" and says nothing about text that arrives token by token. Starting at the first token counts a reader who watched the ad being written and then left. Starting at the last token counts only someone who had the whole ad in front of them. Both are implemented and reported side by side, and I have not picked one.
2. What should a visibility threshold mean when the ad is one sentence inside a long reply? A fraction of the ad's area in the viewport says little about whether it could be read in the time. The counter has no reading-time model, and area is the only visibility measure it uses.

## Limits

- All events are synthetic, and the scenario mix, and so every proportion above, is my choice.
- The client's clock and the visibility it reports are trusted. Nothing checks that the fraction is real, that the tab was in focus, or that the client is not a bot.
- Delivery is at least once and storage is idempotent. Batches can arrive in any order and the counter does not need an order.
- The drill kills only the Node process. PostgreSQL is never killed or restarted, so a database crash is not tested, and the Compose database keeps its data on tmpfs.
- Where inside a window a kill lands is not seeded, so two runs with the same seed send the same events and can be killed at different moments. The holds make the windows wide on purpose: the drill tests recovery from a kill there, not how often a kill lands there in real use.
- Evidence that a kill landed in a window is the server's own log line, not an independent observation.
- A client that reuses an event id for two different views, or contradicts itself, can leave a view row with no events behind. The report does not show it, because it joins on verdicts.
- A changed threshold or duration applies to new batches at once and to stored traffic only after `npm run recompute`, so the two can be mixed until it is run.
- Times are integer milliseconds up to 2147483647 (a little under 25 days). There is no TLS, no rate limit, and keys come from an environment variable. Events cannot be deleted or corrected through the API.
- The rule comes from the 2014 guideline listed below. I did not check whether later documents change it.

## Background reading

- Why Accurate Impression Counting Matters in the Age of AI Advertising: https://www.koahlabs.com/blog/why-accurate-impression-counting-matters-in-the-age-of-ai-advertising
- MRC Viewable Ad Impression Measurement Guidelines, version 1.0 (Final), 30 June 2014, prepared with the IAB Emerging Innovations Task Force: https://www.iab.com/wp-content/uploads/2015/06/MRC-Viewable-Ad-Impression-Measurement-Guideline.pdf

MIT licensed.

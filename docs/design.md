# Design notes

Two jobs: decide whether one showing of an ad counts as a viewable impression, and store the events that decision rests on without losing or double-counting any. They are separate on purpose. The counter is a pure function (`src/viewability.ts`); the store is PostgreSQL (`src/ingest.ts`).

## A view and its events

A view is one showing of one ad. The client sends four kinds of event about it, each with a client-side time in milliseconds since the view started (`tsMs`) and a sequence number (`seq`):

| type | meaning |
| --- | --- |
| `first_token` | the first token of the ad text was drawn |
| `render_complete` | the last token was drawn |
| `visibility` | the fraction of the ad inside the viewport changed, or a heartbeat repeated it (`visibleFraction`, 0 to 1) |
| `view_end` | the client stopped reporting |

Every event also carries an `eventId` (the idempotency key), a `viewId` and an `adId`. A view has one ad; an event that names a different ad than its view already has is rejected as `ad_mismatch`.

## The rule

A view counts when the ad is at or above a visibility threshold for a minimum time without a break. The defaults are 0.5 of the ad and 1000 ms, and both are inclusive: exactly 0.5 for exactly 1000 ms counts (tested at the boundary on both sides). They can be changed with `VIEWABLE_THRESHOLD` and `VIEWABLE_MIN_MS`.

How the events are read:

- A visibility sample holds from its time until the next sample.
- A break below the threshold ends the stretch, and a new stretch starts from zero.
- If several samples share one time, the one with the highest `seq` is the one in effect, and the others hold for no time, so they cannot end a stretch. If they also share `seq` and disagree, the lower fraction is taken. A client that sends that is wrong, and it is not counted in its own favour.
- A stretch still open at the end of the data is credited up to the view's latest event and no further. The counter does not assume the ad stayed on screen after the client's last report.
- The result depends on the set of events and not on the order they arrive in, and an event delivered twice changes nothing. Both are property tests.

### The timer start

The clock for a stretch may not start before the strategy's timer start, and a stretch that began earlier is credited from the timer start:

| strategy | the clock starts at |
| --- | --- |
| `first-token` | the first `first_token` event |
| `fully-rendered` | the first `render_complete` event |

If the event a strategy needs never arrives (a cancelled stream has no `render_complete`), that strategy does not count the view. Both strategies are evaluated for every view and the report shows both, so the choice can be made later and changed without losing anything.

Why it matters: a reader who is looking at the ad while it is still being written, and scrolls away half a second after the last token, is a view under `first-token` and not under `fully-rendered`. The synthetic traffic has a scenario for each kind of disagreement (`src/synthetic.ts`), with the expected outcome under each rule written next to it.

### Where the rule comes from, and what it leaves open

For display ads, the MRC guideline I read (Viewable Ad Impression Measurement Guidelines, version 1.0 Final, 30 June 2014, prepared with the IAB) asks for at least 50% of the ad's pixels on an in-focus browser tab for at least one continuous second, measured "post ad render", and says the clock starts only once the 50% condition is met. For video it asks for two continuous seconds. That is where the defaults, the inclusive comparison and the "continuous" come from.

It says nothing about text that is generated while the reader watches, so "post ad render" can be read two ways here: from the first token, or from the last. This repository implements both and does not choose. Which one a measurement standard should use is an open question, and so is the second one the background post raises: when the ad is one sentence inside a long reply, a fraction of its area in the viewport may say little about whether it could be read. The counter has no notion of reading time.

I did not check whether later MRC documents change any of this.

## Ingestion

`POST /v1/events` takes a batch of up to 500 events for the tenant that owns the bearer key. Delivery from the client is at least once: it resends a batch until it gets a 200. Storage makes that safe.

- **Idempotency key.** The primary key of `events` is `(tenant_id, event_id)`, so two tenants can use the same id without touching each other. The insert is `ON CONFLICT (tenant_id, event_id) DO NOTHING`.
- **Duplicate or conflict.** Each event also stores a hash of its content. An event id that comes back with the same content is a duplicate. One that comes back with different content is a conflict: it is reported, and the first version stays.
- **One transaction per batch.** The batch's events and the recomputed verdicts of every view it touched commit together. A process killed before COMMIT leaves nothing behind. A process killed after COMMIT and before the reply leaves everything stored, and the resend is answered as all duplicates. Both cases are exercised by the fault drill.
- **Locking.** Inside the transaction the `ad_views` row of every touched view is locked with `SELECT ... ORDER BY view_id FOR UPDATE` before any event is written. Two batches that carry events of the same view therefore run one after the other, and the second recomputes the view from the first one's committed events as well as its own. Without the lock, two concurrent batches would each recompute from a snapshot that lacks the other's events and the later write could leave the verdict wrong. Rows are created and locked in view id order, so two batches cannot wait on each other in a circle. The tests and the drill count deadlock retries and require zero.
- **Retries.** A transaction rolled back by a deadlock (40P01) or serialization failure (40001) is run again, up to 8 times. The count is returned in the response.
- **What 200 means.** Every event in the request is accounted for in the body: `accepted` were written now, `duplicates` were already stored, `conflicts` were already stored with different content, `rejected` were not stored. Nothing is silently dropped.

The raw events are the source of truth. `view_results` is derived and can be rebuilt with `npm run recompute`, which is how a changed threshold or duration is applied to traffic that was already stored.

## The fault drill

`scripts/fault-drill.ts` runs the real server as a child process against a throwaway database and kills it with SIGKILL. Two settings, `FAULT_HOLD_BEFORE_COMMIT_MS` and `FAULT_HOLD_AFTER_COMMIT_MS`, keep a transaction open and delay a reply, so a kill lands inside a window that would otherwise last a few milliseconds. The drill reads the server's own log to see whether a transaction was open, or a commit had happened, before it sends the signal. Batches of one tenant wait for each other's view locks, so only one or two transactions are open at any moment. For a kill before COMMIT the drill therefore looks again just before the signal and waits for the next open transaction if the one it saw has already committed. The drill record keeps, for every kill, what the log showed at that instant.

The source of truth is the generator: every synthetic view comes from a scenario whose outcome under each rule is written down next to it, not computed by the counter. The checker (`src/check.ts`) compares the database with that, and also compares the stored verdicts with a fresh evaluation of the stored events. A test checks that the counter agrees with the written expectations, so the two do not drift.

What it does not cover is in the README under Limits.

## Mutation check

`scripts/mutation-check.ts` puts one defect at a time into a copy of the code (an exclusive threshold, a missing lock, no transaction, a tenant-less key, and so on) and runs the unit tests, the database tests and a small drill until one fails. A defect that no suite notices is listed as such. The property tests run with a fixed seed there so that only the defect can make them fail.

// Sends a small synthetic stream to a running server, so the report page has something to show.
// Usage: npm run seed-demo   (BASE_URL and the demo keys can be overridden by environment variables)

import type { IngestResult } from '../src/ingest.js';
import { DEMO_TENANT_KEYS } from '../src/config.js';
import { generateDataset, planDelivery } from '../src/synthetic.js';

const baseUrl = process.env['BASE_URL'] ?? 'http://127.0.0.1:8787';
const keyOf = new Map(Object.entries(DEMO_TENANT_KEYS).map(([key, tenant]) => [tenant, key]));

const dataset = generateDataset({ seed: 42, tenants: ['alpha', 'bravo'], viewsPerTenant: 300 });
const plan = planDelivery(dataset, { seed: 42, batchSize: 100, duplicateShare: 0.2, replayShare: 0.1 });

let accepted = 0;
let duplicates = 0;
for (const batch of plan.batches) {
  const res = await fetch(`${baseUrl}/v1/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${keyOf.get(batch.tenant)}` },
    body: JSON.stringify({ events: batch.events }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const body = (await res.json()) as IngestResult;
  accepted += body.accepted;
  duplicates += body.duplicates;
}
console.log(
  `sent ${plan.batches.length} batches, ${plan.deliveries} deliveries of ${plan.distinctEvents} distinct events; ` +
    `stored ${accepted}, answered ${duplicates} as duplicates`,
);

/** Validate independent request evidence after the documented browser scenario. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const events = (await readFile('.temp/ui-simulation/requests.jsonl', 'utf8')).trim().split('\n').map(JSON.parse);
const activations = events.filter(event => event.path === '/api/activate');
const retry = activations.filter(event => event.body.code === 'RETRY-A');
assert.equal(retry.length, 2, 'Exercise first 503 and same-code successful retry.');
assert.equal(retry[0].key, retry[1].key, 'Uncertain activation retry must retain idempotency key.');
assert.notEqual(activations.find(event => event.body.code === 'RETRY-B').key, activations.find(event => event.body.code === 'RETRY-C').key, 'Changing the code must start a fresh attempt.');
const profiles = events.filter(event => event.path === '/api/profile');
assert.equal(profiles.length, 1, 'Invalid email must be blocked before another PUT.');
assert.equal(profiles[0].body.country, 'CN');
assert.equal(profiles[0].body.email, 'fixture@example.invalid');
assert.equal(profiles[0].body.display_name, 'Synthetic UI Customer');
assert.ok(events.filter(event => event.method !== 'GET').every(event => event.csrf === 'synthetic-csrf'));
console.log('PASS: observed retry idempotency, changed-code attempt, profile normalization, native invalid-email blocking, and mutation CSRF.');

/** Persist/query the exact safe telemetry SQL while proving expiry and closed-field constraints. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

/** Extract only literal prepared statements from production telemetry implementation. */
function source(path) { return readFileSync(new URL(`../../${path}`,import.meta.url),'utf8'); }

test('Billing trace persistence is closed, bounded, and logically expires without request wrappers',()=>{
  const db=new DatabaseSync(':memory:'); db.exec(source('migrations/billing/0005_trace_spans.sql'));
  const rust=source('crates/billing/src/telemetry.rs');
  const statements=[...rust.matchAll(/\.prepare\("([^"\n]+)"\)/g)].map(m=>m[1]);
  const insert=db.prepare(statements.find(s=>s.startsWith('INSERT INTO billing_trace_spans')));
  const query=db.prepare(statements.find(s=>s.startsWith('SELECT event_id')));
  const trace='1'.repeat(32), span='2'.repeat(16);
  for(let i=0;i<130;i++) insert.run(`event-${i}`,1,'billing','billing_authorize','request_exit',trace,span,null,1000+i,2,'success',200,2000+i);
  assert.equal(query.all(trace,1000).length,128);
  assert.equal(query.all(trace,999999).length,0);
  const fields=Object.keys(query.all(trace,1000)[0]);
  assert.equal(fields.length,12); assert.ok(!fields.some(k=>/url|request|owner|token|account|code/.test(k)));
  assert.throws(()=>insert.run('bad',1,'billing','/private/capability','request_exit',trace,span,null,1000,2,'success',200,2000),/CHECK/);
  assert.equal(rust.includes('console_log!'),false);
  assert.ok(rust.includes('let _ = persist'));
  db.close();
});

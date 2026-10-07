/** Runs the actual authorization migration and Rust write statements on SQLite. */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

/** Extracts static production SQL so the simulation follows the real write path. */
function sql(prefix) {
  const source = readFileSync(new URL('../../crates/billing/src/amail.rs', import.meta.url), 'utf8');
  const matches = [...source.matchAll(/"((?:INSERT INTO|UPDATE) amail_authorizations[^"\n]*)"/g)];
  const found = matches.find((match) => match[1].startsWith(prefix));
  assert.ok(found, `production SQL found: ${prefix}`);
  return found[1];
}

/** Produces two unrelated payers and access to the production SQL statements. */
function fixture() {
  const db = new DatabaseSync(':memory:');
  for (const name of ['0001_billing.sql', '0002_admin_issuance.sql', '0003_amail_authorizations.sql', '0004_amail_usage.sql', '0005_trace_spans.sql', '0006_amail_usd.sql']) {
    db.exec(readFileSync(new URL(`../../migrations/billing/${name}`, import.meta.url), 'utf8'));
  }
  db.exec(`INSERT INTO billing_accounts(id,issuer,subject,created_at,updated_at)
    VALUES('payer-a','issuer','a',1,1),('payer-b','issuer','b',1,1)`);
  const statement = db.prepare(sql('INSERT INTO'));
  const insert = { run: (...args) => statement.run(...args, null, null, 'USD') };
  const approve = db.prepare(sql("UPDATE amail_authorizations SET status='approved'"));
  return { db, insert, approve };
}

test('idempotent creation and one-shot approval commit the payer binding atomically', () => {
  const { db, insert, approve } = fixture();
  const first = ['authorization-a', 'owner', 'key', 'request', 'amail-free', 0, 'https://example.com', 1, 1000];
  assert.equal(insert.run(...first).changes, 1);
  assert.equal(insert.run('different-random-id', ...first.slice(1)).changes, 0);
  assert.equal(approve.run('authorization-a', 'payer-a', 'amail-free', 10, null, '[]', 2).changes, 1);
  const binding = db.prepare('SELECT * FROM amail_bindings').get();
  assert.equal(binding.owner_id, 'owner');
  assert.equal(binding.account_id, 'payer-a');
  assert.equal(binding.overage_budget_micros, 10);
  assert.equal(approve.run('authorization-a', 'payer-b', 'amail-plus', 100, 999, '[]', 3).changes, 0);
  assert.equal(db.prepare('SELECT account_id FROM amail_bindings').get().account_id, 'payer-a');
  db.close();
});

test('payer mismatch rolls back authorization status and expired proposals cannot approve', () => {
  const { db, insert, approve } = fixture();
  insert.run('a', 'owner', 'key-a', 'hash', 'amail-free', 0, 'https://example.com', 1, 100);
  approve.run('a', 'payer-a', 'amail-free', 0, null, '[]', 2);
  insert.run('b', 'owner', 'key-b', 'hash', 'amail-free', 0, 'https://example.com', 1, 100);
  assert.throws(() => approve.run('b', 'payer-b', 'amail-free', 0, null, '[]', 3), /amail_payer_conflict/);
  assert.equal(db.prepare("SELECT status FROM amail_authorizations WHERE id='b'").get().status, 'pending');
  assert.equal(db.prepare('SELECT authorization_id FROM amail_bindings').get().authorization_id, 'a');
  insert.run('expired', 'other', 'key', 'hash', 'amail-free', 0, 'https://example.com', 1, 2);
  assert.equal(approve.run('expired', 'payer-b', 'amail-free', 0, null, '[]', 3).changes, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM amail_bindings WHERE owner_id='other'").get().n, 0);
  db.close();
});


test('same-second human approvals monotonically advance binding authority version',()=>{
  const {db,insert,approve}=fixture();
  insert.run('first','owner','key1','hash','amail-free',100,'https://example.com',1,1000);
  approve.run('first','payer-a','amail-free',100,null,'[]',2);
  insert.run('second','owner','key2','hash','amail-free',10,'https://example.com',1,1000);
  approve.run('second','payer-a','amail-free',10,null,'[]',2);
  assert.equal(db.prepare('SELECT updated_at FROM amail_bindings').get().updated_at,3);
  assert.equal(db.prepare("SELECT approved_at FROM amail_authorizations WHERE id='second'").get().approved_at,2);
  db.close();
});

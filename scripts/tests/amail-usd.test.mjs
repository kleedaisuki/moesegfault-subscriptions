/** Actual USD cutover: immutable CNY history, explicit receipts, isolated budgets and production SQL. */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

/** Apply a checked-in migration through SQLite's real constraints and trigger engine. */
function migrate(db, name) { db.exec(readFileSync(new URL(`../../migrations/billing/${name}`, import.meta.url), 'utf8')); }
/** Extract the static production statement rather than duplicating HTTP write semantics in a mock. */
function productionSql(file, prefix) {
  const source = readFileSync(new URL(`../../crates/billing/src/${file}.rs`, import.meta.url), 'utf8');
  const sql = [...source.matchAll(/"((?:INSERT INTO|UPDATE|SELECT)[^"\n]*)"/g)].find(match => match[1].startsWith(prefix))?.[1];
  assert.ok(sql, `production SQL exists: ${prefix}`);
  return sql;
}
/** Historical six-event fixture mirrors the real staged currency totals, not their private IDs. */
function fixture() {
  const db = new DatabaseSync(':memory:');
  for (const name of ['0001_billing.sql', '0002_admin_issuance.sql', '0003_amail_authorizations.sql', '0004_amail_usage.sql', '0005_trace_spans.sql']) migrate(db, name);
  db.exec(`INSERT INTO billing_accounts(id,issuer,subject,created_at,updated_at) VALUES('payer','issuer','subject',1,1);
    INSERT INTO amail_authorizations(id,owner_id,idempotency_key_hash,request_hash,plan_id,overage_budget_micros,return_url,created_at,expires_at)
      VALUES('cny-receipt','owner','legacy-key','legacy-hash','amail-lite',100,'https://example.com',1,1000),
      ('cny-pending','owner','legacy-pending','legacy-hash','amail-lite',100,'https://example.com',1,1000);
    UPDATE amail_authorizations SET account_id='payer',approved_at=2,status='approved',valid_until=1000 WHERE id='cny-receipt';`);
  const oldInsert = db.prepare(`INSERT INTO amail_usage_events(event_id,owner_id,period_start,period_end,meter,quantity,amount_micros,occurred_at,authorization_id,authorized_at)
    VALUES(?,'owner',100,200,'address_seconds',1,?,150,'cny-receipt',150)`);
  for (const [index, amount] of [1,2,3,4,5,7].entries()) oldInsert.run(`history-${index}`,amount);
  const history = db.prepare('SELECT * FROM amail_usage_events ORDER BY event_id').all().map(row => ({ ...row }));
  migrate(db, '0006_amail_usd.sql');
  const intent = db.prepare(productionSql('amail','INSERT INTO amail_authorizations'));
  const approve = db.prepare(productionSql('amail',"UPDATE amail_authorizations SET status='approved'"));
  const insert = db.prepare(productionSql('amail_usage','INSERT INTO amail_usage_events'));
  /** New intents cannot be created with missing/legacy CNY denomination. */
  function create(id, currency = 'USD', budget = 100, at = 160) {
    return intent.run(id,'owner',id,`hash-${id}`,'amail-lite',budget,'https://example.com',at,1000,null,null,currency);
  }
  /** Authoritative existing paid grant is independent from the new spending currency. */
  function consent(id, budget = 100, at = 160) {
    create(id,'USD',budget,at);
    return approve.run(id,'payer','amail-lite',budget,1000,'["amail.plan.lite"]',at);
  }
  /** Exact decimal string binding follows the real D1 write path. */
  function event(id, currency, receipt, amount, admitted = 170, start = 100, end = 200, observed = 250) {
    return insert.run(id,'owner',String(start),String(end),'address_seconds','1',String(amount),String(observed),receipt,String(admitted),currency);
  }
  return { db, history, create, approve, consent, event };
}

test('additive migration tags six CNY events totaling 22 without rewriting historical payloads', () => {
  const { db, history, event } = fixture();
  const rows = db.prepare('SELECT * FROM amail_usage_events ORDER BY event_id').all();
  assert.deepEqual(rows.map(({ currency, ...row }) => row), history);
  assert.ok(rows.every(row => row.currency === 'CNY'));
  assert.equal(db.prepare("SELECT SUM(amount_micros) AS n FROM amail_usage_events WHERE currency='CNY'").get().n,22);
  assert.equal(db.prepare('SELECT currency,plan_id,overage_budget_micros FROM amail_bindings').get().currency,'CNY');
  assert.equal(event('history-0','CNY','cny-receipt',1,150,100,200,150).changes,0);
  assert.throws(() => db.exec("UPDATE amail_usage_events SET currency='USD'"), /amail_usage_immutable/);
  assert.throws(() => db.exec("UPDATE amail_authorizations SET currency='USD' WHERE id='cny-pending'"), /amail_currency_immutable/);
  db.close();
});

test('old CNY pending requests cannot approve dollars; only explicit fresh USD consent changes the binding', () => {
  const { db, create, approve, consent } = fixture();
  assert.equal(create('forbidden-cny','CNY').changes,0);
  assert.equal(approve.run('cny-pending','payer','amail-lite',100,1000,'[]',160).changes,0);
  assert.throws(() => db.exec("UPDATE amail_authorizations SET status='approved',account_id='payer',approved_at=160 WHERE id='cny-pending'"), /amail_currency_upgrade_required/);
  assert.equal(db.prepare('SELECT currency FROM amail_bindings').get().currency,'CNY');
  consent('usd-receipt',0);
  const binding = db.prepare('SELECT currency,plan_id,overage_budget_micros FROM amail_bindings').get();
  assert.equal(binding.currency,'USD'); assert.equal(binding.plan_id,'amail-lite'); assert.equal(binding.overage_budget_micros,0);
  assert.equal(db.prepare("SELECT currency,status FROM amail_authorizations WHERE id='cny-receipt'").get().currency,'CNY');
  db.close();
});

test('USD cap and period totals are independent from preserved CNY, and replay denomination is immutable', () => {
  const { db, consent, event } = fixture();
  consent('usd-receipt',22);
  event('usd-one','USD','usd-receipt',22);
  assert.equal(event('usd-one','USD','usd-receipt',22).changes,0);
  assert.throws(() => event('usd-over','USD','usd-receipt',1), /amail_budget_exceeded/);
  assert.throws(() => event('usd-one','CNY','usd-receipt',22), /amail_event_conflict/);
  assert.throws(() => event('wrong-receipt','USD','cny-receipt',0), /amail_consent_invalid/);
  const totals = db.prepare(productionSql('amail_usage','SELECT COALESCE(SUM(amount_micros)'));
  assert.equal(totals.get('owner','100','USD').amount_micros,22);
  assert.equal(totals.get('owner','100','CNY').amount_micros,22);
  const budget = db.prepare(productionSql('amail_usage','SELECT CASE WHEN currency'));
  assert.equal(budget.get('owner','CNY').overage_budget_micros,0);
  // The fixture expiry is ancient; extend it independently of the receipt to exercise current summary only.
  db.exec('UPDATE amail_bindings SET valid_until=NULL');
  assert.equal(budget.get('owner','USD').overage_budget_micros,22);
  assert.equal(budget.get('owner','CNY').overage_budget_micros,0);
  db.close();
});

test('overlap is currency scoped; USD supersedes new CNY admission but preserves older CNY backlog', () => {
  const { db, consent, event } = fixture();
  consent('usd-receipt',100);
  // Distinct currency periods may overlap; within one denomination the existing nonoverlap guard stays strict.
  event('usd-period','USD','usd-receipt',10,170,110,210);
  assert.throws(() => event('usd-overlap','USD','usd-receipt',1,170,120,220),/amail_period_conflict/);
  assert.throws(() => event('new-cny-after-usd','CNY','cny-receipt',0,170),/amail_consent_invalid/);
  event('late-cny','CNY','cny-receipt',78,150);
  assert.throws(() => event('cny-over','CNY','cny-receipt',1,150),/amail_budget_exceeded/);
  assert.equal(db.prepare("SELECT SUM(amount_micros) AS n FROM amail_usage_events WHERE currency='CNY'").get().n,100);
  db.close();
});

test('zeroing new USD cap preserves original USD reservation authority without importing CNY budget', () => {
  const { db, consent, event } = fixture();
  consent('usd-original',100,160);
  consent('usd-zero',0,180);
  event('delayed-usd','USD','usd-original',100,170);
  assert.throws(() => event('new-usd','USD','usd-zero',1,190),/amail_budget_exceeded/);
  assert.throws(() => event('backdated-receipt','USD','usd-original',0,190),/amail_consent_invalid/);
  assert.equal(db.prepare("SELECT SUM(amount_micros) AS n FROM amail_usage_events WHERE currency='CNY'").get().n,22);
  assert.equal(db.prepare('SELECT currency,overage_budget_micros FROM amail_bindings').get().overage_budget_micros,0);
  db.close();
});

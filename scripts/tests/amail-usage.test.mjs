/** Exercises the deployed SQL ledger contract against real SQLite, not a mock. */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

/** Builds the full migration chain and a human-approved payer binding. */
function fixture() {
  const db = new DatabaseSync(':memory:');
  for (const name of ['0001_billing.sql','0002_admin_issuance.sql','0003_amail_authorizations.sql','0004_amail_usage.sql']) db.exec(readFileSync(new URL(`../../migrations/billing/${name}`,import.meta.url),'utf8'));
  db.exec(`INSERT INTO billing_accounts(id,issuer,subject,created_at,updated_at) VALUES('payer','issuer','subject',1,1);
    INSERT INTO amail_authorizations(id,owner_id,idempotency_key_hash,request_hash,plan_id,overage_budget_micros,return_url,created_at,expires_at)
      VALUES('approval','owner','key','hash','amail-free',100,'https://example.com',1,500);
    UPDATE amail_authorizations SET account_id='payer',approved_at=2,status='approved' WHERE id='approval';`);
  const raw=db.prepare(`INSERT INTO amail_usage_events(event_id,owner_id,period_start,period_end,meter,quantity,amount_micros,occurred_at,authorization_id,authorized_at)
    VALUES(?,?,100,200,'storage_byte_seconds',?,?,?,'approval',?) ON CONFLICT(event_id) DO NOTHING`);
  const insert={run:(event,owner,quantity,amount,observed=150,authorized=150)=>raw.run(event,owner,quantity,amount,observed,authorized)};
  return {db,insert};
}

test('exact quantities, idempotency, atomic cumulative budget, and immutable liability',()=>{
  const {db,insert}=fixture(); const quantity=25_920_000_000_000_001n;
  insert.run('one','owner',quantity,60); insert.run('one','owner',quantity,60);
  assert.equal(db.prepare('SELECT CAST(quantity AS TEXT) AS n FROM amail_usage_events').get().n,quantity.toString());
  assert.throws(()=>insert.run('one','owner',quantity,61),/amail_event_conflict/);
  assert.throws(()=>insert.run('two','owner',quantity,41),/amail_budget_exceeded/);
  insert.run('two','owner',quantity,40);
  assert.equal(db.prepare('SELECT SUM(amount_micros) AS n FROM amail_usage_events').get().n,100);
  assert.throws(()=>db.exec('DELETE FROM amail_usage_events'),/amail_usage_immutable/);
  assert.throws(()=>db.exec('UPDATE amail_usage_events SET amount_micros=0'),/amail_usage_immutable/); db.close();
});

test('authorization, nonoverlapping periods, and nonnegative dimensions are enforced by SQL',()=>{
  const {db,insert}=fixture();
  assert.throws(()=>insert.run('absent','unknown',1,0),/amail_binding_required/);
  assert.throws(()=>insert.run('negative','owner',-1,0),/CHECK/); insert.run('one','owner',1,10);
  assert.throws(()=>db.exec(`INSERT INTO amail_usage_events VALUES('overlap','owner',101,200,'address_seconds',1,1,150,'approval',150,'pending_settlement')`),/amail_period_conflict/);
  db.exec(`INSERT INTO amail_usage_events VALUES('next','owner',200,300,'address_seconds',1,100,250,'approval',250,'pending_settlement')`);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM amail_usage_events').get().n,2); db.close();
});

test('expired consent permits historical admission and exact retries but no new admission',()=>{
  const {db,insert}=fixture(); db.exec("UPDATE amail_authorizations SET valid_until=150 WHERE id='approval'");
  insert.run('one','owner',1,10,250,140); insert.run('one','owner',1,10,250,140);
  assert.throws(()=>insert.run('new','owner',1,1,250,150),/amail_consent_invalid/); db.close();
});

test('stock period boundary and late provider acceptance retain the original accounting period',()=>{
  const {db,insert}=fixture(); insert.run('stock','owner',1,10,200,199); insert.run('late','owner',1,10,500,150);
  assert.equal(db.prepare('SELECT SUM(amount_micros) AS n FROM amail_usage_events WHERE period_start=100').get().n,20); db.close();
});

test('lowering a cap preserves preauthorized backlog without resetting total period liability',()=>{
  const {db,insert}=fixture();
  db.exec(`INSERT INTO amail_authorizations(id,owner_id,idempotency_key_hash,request_hash,plan_id,overage_budget_micros,return_url,created_at,expires_at)
    VALUES('lower','owner','key-lower','hash','amail-free',20,'https://example.com',155,500);
    UPDATE amail_authorizations SET account_id='payer',approved_at=160,status='approved' WHERE id='lower';`);
  insert.run('old-hold','owner',1,60,250,150);
  assert.throws(()=>insert.run('backdated-after-lower','owner',1,1,250,170),/amail_consent_invalid/);
  assert.throws(()=>db.exec(`INSERT INTO amail_usage_events VALUES('new-lower','owner',100,200,'outbound_recipients',1,1,250,'lower',170,'pending_settlement')`),/amail_budget_exceeded/);
  insert.run('another-old-hold','owner',1,40,250,155);
  assert.throws(()=>insert.run('old-exceeds-shared-cap','owner',1,1,250,155),/amail_budget_exceeded/); db.close();
});

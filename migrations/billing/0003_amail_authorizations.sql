-- Human-authorized service account links preserve amail's existing Identity subject sector.
CREATE TABLE amail_authorizations (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  idempotency_key_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  plan_id TEXT NOT NULL CHECK (plan_id IN ('amail-free','amail-lite','amail-plus')),
  overage_budget_micros INTEGER NOT NULL CHECK (overage_budget_micros BETWEEN 0 AND 1000000000000),
  return_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','cancelled')),
  account_id TEXT REFERENCES billing_accounts(id),
  valid_until INTEGER,
  entitlements_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  approved_at INTEGER,
  trace_id TEXT,
  parent_span_id TEXT,
  UNIQUE(owner_id,idempotency_key_hash),
  CHECK (expires_at > created_at)
);
CREATE TABLE amail_bindings (
  owner_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES billing_accounts(id),
  plan_id TEXT NOT NULL CHECK (plan_id IN ('amail-free','amail-lite','amail-plus')),
  overage_budget_micros INTEGER NOT NULL CHECK (overage_budget_micros BETWEEN 0 AND 1000000000000),
  authorization_id TEXT NOT NULL REFERENCES amail_authorizations(id),
  valid_until INTEGER,
  entitlements_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
-- Approval and payer binding commit together; the browser cannot replace an existing payer.
CREATE TRIGGER amail_authorization_bind AFTER UPDATE OF status ON amail_authorizations
WHEN NEW.status='approved' AND OLD.status='pending'
BEGIN
  SELECT RAISE(ABORT,'amail_payer_conflict') WHERE EXISTS(
    SELECT 1 FROM amail_bindings WHERE owner_id=NEW.owner_id AND account_id<>NEW.account_id
  );
  INSERT INTO amail_bindings(owner_id,account_id,plan_id,overage_budget_micros,authorization_id,valid_until,entitlements_json,updated_at)
  VALUES(NEW.owner_id,NEW.account_id,NEW.plan_id,NEW.overage_budget_micros,NEW.id,NEW.valid_until,NEW.entitlements_json,NEW.approved_at)
  ON CONFLICT(owner_id) DO UPDATE SET plan_id=excluded.plan_id,
    overage_budget_micros=excluded.overage_budget_micros,authorization_id=excluded.authorization_id,
    valid_until=excluded.valid_until,entitlements_json=excluded.entitlements_json,
    updated_at=MAX(excluded.updated_at,amail_bindings.updated_at+1);
END;

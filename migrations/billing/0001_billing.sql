-- Principal identity is immutable and environment-isolated by the deployment's issuer.
PRAGMA foreign_keys = ON;
CREATE TABLE billing_accounts (
  id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  profile_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (issuer, subject)
);

-- Raw codes never enter D1. Plan snapshots honor issued grants even after catalog changes.
CREATE TABLE activation_codes (
  code_hash TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL CHECK (duration_seconds BETWEEN 86400 AND 315360000),
  entitlements_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK (expires_at > created_at)
);
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES billing_accounts(id),
  product_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  current_period_start INTEGER NOT NULL,
  current_period_end INTEGER NOT NULL,
  entitlements_json TEXT NOT NULL,
  activation_source TEXT NOT NULL DEFAULT 'activation_code',
  UNIQUE (account_id, product_id),
  CHECK (current_period_end > current_period_start)
);

-- Both uniqueness constraints arbitrate retries and competing users in the database.
CREATE TABLE activation_redemptions (
  code_hash TEXT PRIMARY KEY REFERENCES activation_codes(code_hash),
  account_id TEXT NOT NULL REFERENCES billing_accounts(id),
  idempotency_key_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  redeemed_at INTEGER NOT NULL,
  subscription_id TEXT NOT NULL,
  result_json TEXT,
  UNIQUE (account_id, idempotency_key_hash)
);

-- One accepted INSERT performs the full grant atomically; callers never race read/update.
CREATE TRIGGER activation_grant AFTER INSERT ON activation_redemptions BEGIN
  INSERT INTO subscriptions (
    id, account_id, product_id, plan_id, current_period_start, current_period_end, entitlements_json
  ) SELECT NEW.subscription_id, NEW.account_id, c.product_id, c.plan_id,
      NEW.redeemed_at, NEW.redeemed_at + c.duration_seconds, c.entitlements_json
    FROM activation_codes c WHERE c.code_hash = NEW.code_hash
  ON CONFLICT(account_id, product_id) DO UPDATE SET
    plan_id = excluded.plan_id,
    current_period_start = CASE WHEN subscriptions.current_period_end > NEW.redeemed_at
      THEN subscriptions.current_period_start ELSE NEW.redeemed_at END,
    current_period_end = MAX(subscriptions.current_period_end, NEW.redeemed_at)
      + (SELECT duration_seconds FROM activation_codes WHERE code_hash = NEW.code_hash),
    entitlements_json = excluded.entitlements_json;
  UPDATE activation_redemptions SET
    subscription_id = (SELECT s.id FROM subscriptions s JOIN activation_codes c
      ON c.product_id = s.product_id WHERE s.account_id = NEW.account_id AND c.code_hash = NEW.code_hash),
    result_json = (SELECT json_object('id',s.id,'product_id',s.product_id,'plan_id',s.plan_id,
      'current_period_start',s.current_period_start,'current_period_end',s.current_period_end,
      'activation_source',s.activation_source,'status','active','entitlements',json(s.entitlements_json))
      FROM subscriptions s JOIN activation_codes c ON c.product_id = s.product_id
      WHERE s.account_id = NEW.account_id AND c.code_hash = NEW.code_hash)
  WHERE code_hash = NEW.code_hash;
END;

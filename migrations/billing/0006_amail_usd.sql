-- Fixed USD new billing; applied CNY amounts and original approval receipts stay immutable.
-- DEFAULT CNY tags existing rows without rewriting an amount or invoking an FX conversion.
ALTER TABLE amail_authorizations ADD COLUMN currency TEXT NOT NULL DEFAULT 'CNY' CHECK(currency IN ('CNY','USD'));
ALTER TABLE amail_bindings ADD COLUMN currency TEXT NOT NULL DEFAULT 'CNY' CHECK(currency IN ('CNY','USD'));
ALTER TABLE amail_usage_events ADD COLUMN currency TEXT NOT NULL DEFAULT 'CNY' CHECK(currency IN ('CNY','USD'));
CREATE INDEX amail_usage_owner_currency_period ON amail_usage_events(owner_id,currency,period_start);

-- A consent denomination cannot be changed, including before approval.
CREATE TRIGGER amail_authorization_currency_immutable BEFORE UPDATE OF currency ON amail_authorizations
WHEN OLD.currency != NEW.currency
BEGIN
  SELECT RAISE(ABORT,'amail_currency_immutable');
END;
-- Old pending requests cannot silently become permission to spend dollars.
CREATE TRIGGER amail_authorization_current_consent BEFORE UPDATE OF status ON amail_authorizations
WHEN NEW.status='approved' AND OLD.status='pending' AND NEW.currency != 'USD'
BEGIN
  SELECT RAISE(ABORT,'amail_currency_upgrade_required');
END;
DROP TRIGGER amail_authorization_bind;
CREATE TRIGGER amail_authorization_bind AFTER UPDATE OF status ON amail_authorizations
WHEN NEW.status='approved' AND OLD.status='pending'
BEGIN
  SELECT RAISE(ABORT,'amail_payer_conflict') WHERE EXISTS(
    SELECT 1 FROM amail_bindings WHERE owner_id=NEW.owner_id AND account_id<>NEW.account_id
  );
  INSERT INTO amail_bindings(owner_id,account_id,plan_id,overage_budget_micros,authorization_id,valid_until,entitlements_json,updated_at,currency)
  VALUES(NEW.owner_id,NEW.account_id,NEW.plan_id,NEW.overage_budget_micros,NEW.id,NEW.valid_until,NEW.entitlements_json,NEW.approved_at,NEW.currency)
  ON CONFLICT(owner_id) DO UPDATE SET plan_id=excluded.plan_id,currency=excluded.currency,
    overage_budget_micros=excluded.overage_budget_micros,authorization_id=excluded.authorization_id,
    valid_until=excluded.valid_until,entitlements_json=excluded.entitlements_json,
    updated_at=MAX(excluded.updated_at,amail_bindings.updated_at+1);
END;

DROP TRIGGER amail_usage_budget;
DROP TRIGGER amail_usage_retry;
CREATE TRIGGER amail_usage_budget BEFORE INSERT ON amail_usage_events
WHEN NOT EXISTS (SELECT 1 FROM amail_usage_events WHERE event_id = NEW.event_id)
BEGIN
  SELECT RAISE(ABORT, 'amail_binding_required') WHERE NOT EXISTS (
    SELECT 1 FROM amail_bindings WHERE owner_id = NEW.owner_id
  );
  SELECT RAISE(ABORT, 'amail_period_conflict') WHERE EXISTS (
    SELECT 1 FROM amail_usage_events WHERE owner_id = NEW.owner_id AND currency = NEW.currency
      AND period_start < NEW.period_end AND period_end > NEW.period_start
      AND (period_start != NEW.period_start OR period_end != NEW.period_end)
  );
  SELECT RAISE(ABORT, 'amail_consent_invalid') WHERE NOT EXISTS (
    SELECT 1 FROM amail_authorizations a WHERE a.id=NEW.authorization_id AND a.owner_id=NEW.owner_id
      AND a.currency=NEW.currency AND a.status='approved' AND a.approved_at<=NEW.authorized_at
      AND (a.valid_until IS NULL OR NEW.authorized_at<a.valid_until)
      AND NOT EXISTS(SELECT 1 FROM amail_authorizations newer WHERE newer.owner_id=a.owner_id
        AND newer.status='approved' AND newer.approved_at>a.approved_at AND newer.approved_at<=NEW.authorized_at)
  );
  SELECT RAISE(ABORT, 'amail_budget_exceeded') WHERE NEW.amount_micros>0 AND NEW.amount_micros > (
    SELECT overage_budget_micros FROM amail_authorizations WHERE id=NEW.authorization_id
  ) - COALESCE((SELECT SUM(amount_micros) FROM amail_usage_events
    WHERE owner_id = NEW.owner_id AND period_start = NEW.period_start AND currency = NEW.currency), 0);
END;

-- Idempotency is enforced at the persistence boundary as well as the HTTP boundary.
CREATE TRIGGER amail_usage_retry BEFORE INSERT ON amail_usage_events
WHEN EXISTS (SELECT 1 FROM amail_usage_events WHERE event_id = NEW.event_id AND (
  currency != NEW.currency OR owner_id != NEW.owner_id OR period_start != NEW.period_start OR period_end != NEW.period_end
  OR meter != NEW.meter OR quantity != NEW.quantity OR amount_micros != NEW.amount_micros
  OR occurred_at != NEW.occurred_at OR authorization_id IS NOT NEW.authorization_id
  OR authorized_at IS NOT NEW.authorized_at))
BEGIN
  SELECT RAISE(ABORT, 'amail_event_conflict');
END;


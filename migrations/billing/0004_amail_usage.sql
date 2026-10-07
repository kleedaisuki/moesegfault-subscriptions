-- Usage is a durable liability record, never proof of a payment or settlement.
CREATE TABLE amail_usage_events (
  event_id TEXT PRIMARY KEY CHECK(length(event_id) BETWEEN 1 AND 128),
  owner_id TEXT NOT NULL REFERENCES amail_bindings(owner_id),
  period_start INTEGER NOT NULL CHECK(period_start BETWEEN 0 AND 4102444800),
  period_end INTEGER NOT NULL CHECK(period_end > period_start AND period_end - period_start <= 2764800),
  meter TEXT NOT NULL CHECK(meter IN ('outbound_recipients','storage_byte_seconds','address_seconds')),
  quantity INTEGER NOT NULL CHECK(typeof(quantity) = 'integer' AND quantity BETWEEN 0 AND 1000000000000000000),
  amount_micros INTEGER NOT NULL CHECK(typeof(amount_micros) = 'integer' AND amount_micros BETWEEN 0 AND 1000000000000),
  occurred_at INTEGER NOT NULL CHECK(occurred_at >= period_start AND occurred_at <= 4102444800),
  authorization_id TEXT NOT NULL REFERENCES amail_authorizations(id),
  authorized_at INTEGER NOT NULL CHECK(authorized_at >= period_start AND authorized_at <= occurred_at),
  settlement_status TEXT NOT NULL DEFAULT 'pending_settlement' CHECK(settlement_status = 'pending_settlement')
);
CREATE INDEX amail_usage_owner_period ON amail_usage_events(owner_id, period_start);

-- BEFORE INSERT executes under the same SQLite writer lock as the actual insert.
-- Retries bypass budget checks but conflicting retry payloads are rejected below.
CREATE TRIGGER amail_usage_budget BEFORE INSERT ON amail_usage_events
WHEN NOT EXISTS (SELECT 1 FROM amail_usage_events WHERE event_id = NEW.event_id)
BEGIN
  SELECT RAISE(ABORT, 'amail_binding_required') WHERE NOT EXISTS (
    SELECT 1 FROM amail_bindings WHERE owner_id = NEW.owner_id
  );
  SELECT RAISE(ABORT, 'amail_period_conflict') WHERE EXISTS (
    SELECT 1 FROM amail_usage_events WHERE owner_id = NEW.owner_id
      AND period_start < NEW.period_end AND period_end > NEW.period_start
      AND (period_start != NEW.period_start OR period_end != NEW.period_end)
  );
  SELECT RAISE(ABORT, 'amail_consent_invalid') WHERE NOT EXISTS (
    SELECT 1 FROM amail_authorizations a WHERE a.id=NEW.authorization_id AND a.owner_id=NEW.owner_id
      AND a.status='approved' AND a.approved_at<=NEW.authorized_at
      AND (a.valid_until IS NULL OR NEW.authorized_at<a.valid_until)
      AND NOT EXISTS(SELECT 1 FROM amail_authorizations newer WHERE newer.owner_id=a.owner_id
        AND newer.status='approved' AND newer.approved_at>a.approved_at AND newer.approved_at<=NEW.authorized_at)
  );
  SELECT RAISE(ABORT, 'amail_budget_exceeded') WHERE NEW.amount_micros>0 AND NEW.amount_micros > (
    SELECT overage_budget_micros FROM amail_authorizations WHERE id=NEW.authorization_id
  ) - COALESCE((SELECT SUM(amount_micros) FROM amail_usage_events
    WHERE owner_id = NEW.owner_id AND period_start = NEW.period_start), 0);
END;

-- Idempotency is enforced at the persistence boundary as well as the HTTP boundary.
CREATE TRIGGER amail_usage_retry BEFORE INSERT ON amail_usage_events
WHEN EXISTS (SELECT 1 FROM amail_usage_events WHERE event_id = NEW.event_id AND (
  owner_id != NEW.owner_id OR period_start != NEW.period_start OR period_end != NEW.period_end
  OR meter != NEW.meter OR quantity != NEW.quantity OR amount_micros != NEW.amount_micros
  OR occurred_at != NEW.occurred_at OR authorization_id IS NOT NEW.authorization_id
  OR authorized_at IS NOT NEW.authorized_at))
BEGIN
  SELECT RAISE(ABORT, 'amail_event_conflict');
END;

-- An accepted liability must not be edited or deleted to make room in a budget.
CREATE TRIGGER amail_usage_immutable_update BEFORE UPDATE ON amail_usage_events BEGIN
  SELECT RAISE(ABORT, 'amail_usage_immutable');
END;
CREATE TRIGGER amail_usage_immutable_delete BEFORE DELETE ON amail_usage_events BEGIN
  SELECT RAISE(ABORT, 'amail_usage_immutable');
END;

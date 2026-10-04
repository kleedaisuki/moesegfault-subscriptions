"""Exercise the real migration and Rust SQL without Workers compilation.

Expected behavior comes from docs/api-contract.md: one grant per code, immutable
retry receipts, account-scoped idempotency, and preservation of remaining time.
This validates SQLite semantics, not D1 transport or Rust response serialization.
"""

import concurrent.futures
import json
from pathlib import Path
import re
import sqlite3
import tempfile
import threading
import unittest


ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "crates/billing/src/repository.rs").read_text(encoding="utf-8")
ADMIN_SOURCE = (ROOT / "crates/billing/src/admin.rs").read_text(encoding="utf-8")
# Extract the actual static query so expiry and conflict predicates cannot drift.
REDEEM_SQL = re.search(
    r'"(INSERT INTO activation_redemptions[^"\n]+)"', SOURCE
).group(1)
REPLAY_SQL = re.search(
    r'"(SELECT request_hash,result_json FROM activation_redemptions[^"\n]+)"', SOURCE
).group(1)
CLAIM_SQL = re.search(
    r'"(UPDATE admin_issuance SET status=\'sending\'[^"\n]+)"', ADMIN_SOURCE
).group(1)
NOW = 1_800_000_000
DAY = 86400


def connect(path=":memory:"):
    """Create an independent connection with foreign-key enforcement enabled."""
    connection = sqlite3.connect(path, timeout=5)
    connection.execute("PRAGMA foreign_keys=ON")
    return connection


def initialize(connection):
    """Apply the production schema and create two unrelated authenticated users."""
    connection.executescript(
        (ROOT / "migrations/billing/0001_billing.sql").read_text(encoding="utf-8")
    )
    connection.executemany(
        "INSERT INTO billing_accounts(id,issuer,subject,created_at,updated_at) "
        "VALUES(?, 'https://identity.example', ?, ?, ?)",
        [(account, account, NOW, NOW) for account in ("alice", "bob")],
    )
    connection.commit()


def issue(connection, code="code", duration=DAY, expires=NOW + DAY, plan="basic"):
    """Store a deployment-owned plan snapshot using a synthetic hashed code."""
    connection.execute(
        "INSERT INTO activation_codes VALUES(?, ?, 'app', ?, ?, ?, ?)",
        (code, plan, duration, json.dumps([plan]), NOW - DAY, expires),
    )
    connection.commit()


def redeem(connection, code="code", account="alice", key="key", now=NOW):
    """Execute the exact production INSERT with its positional binding contract."""
    connection.execute(REDEEM_SQL, (code, account, key, now, f"sub-{code}-{account}"))
    connection.commit()


class BillingSqlTests(unittest.TestCase):
    """Cheap independent checks of transactional billing invariants."""

    def setUp(self):
        """Give each test a fresh production schema."""
        self.db = connect()
        self.addCleanup(self.db.close)
        initialize(self.db)

    def receipt(self, account="alice", key="key"):
        """Read durable receipt through the same account-scoped Rust query."""
        row = self.db.execute(REPLAY_SQL, (account, key)).fetchone()
        return None if row is None else (row[0], json.loads(row[1]))

    def test_success_creates_complete_receipt_and_subscription(self):
        """An accepted code immediately produces a usable immutable result."""
        issue(self.db)
        redeem(self.db)
        code, receipt = self.receipt()
        self.assertEqual(code, "code")
        self.assertEqual(receipt, {
            "id": "sub-code-alice", "product_id": "app", "plan_id": "basic",
            "current_period_start": NOW, "current_period_end": NOW + DAY,
            "activation_source": "activation_code", "status": "active",
            "entitlements": ["basic"],
        })
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM subscriptions").fetchone()[0], 1)

    def test_code_is_one_use_across_accounts(self):
        """A second subject cannot obtain an already redeemed code."""
        issue(self.db)
        redeem(self.db)
        redeem(self.db, account="bob")
        self.assertIsNone(self.receipt("bob"))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM subscriptions").fetchone()[0], 1)

    def test_same_request_is_idempotent(self):
        """Retries do not extend time or mutate their receipt."""
        issue(self.db)
        redeem(self.db)
        before = self.receipt()
        redeem(self.db, now=NOW + 100)
        self.assertEqual(self.receipt(), before)
        self.assertEqual(self.db.execute("SELECT current_period_end FROM subscriptions").fetchone()[0], NOW + DAY)

    def test_idempotency_key_is_account_scoped(self):
        """Unrelated users may independently use the same client-generated key."""
        issue(self.db)
        issue(self.db, "bob-code")
        redeem(self.db)
        redeem(self.db, "bob-code", account="bob")
        self.assertEqual(self.receipt("bob")[0], "bob-code")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM subscriptions").fetchone()[0], 2)

    def test_distinct_products_do_not_extend_each_other(self):
        """A principal can hold separate grants for different applications."""
        issue(self.db)
        issue(self.db, "second-product")
        self.db.execute("UPDATE activation_codes SET product_id='other-app' WHERE code_hash='second-product'")
        self.db.commit()
        redeem(self.db)
        redeem(self.db, "second-product", key="second")
        rows = self.db.execute("SELECT product_id,current_period_end FROM subscriptions ORDER BY product_id").fetchall()
        self.assertEqual(rows, [("app", NOW + DAY), ("other-app", NOW + DAY)])

    def test_duration_limits_are_database_enforced(self):
        """Out-of-range issuance cannot bypass the schema's grant constraints."""
        for duration in (DAY - 1, 315360001):
            with self.subTest(duration=duration), self.assertRaises(sqlite3.IntegrityError):
                issue(self.db, f"invalid-{duration}", duration=duration)
            self.db.rollback()
        issue(self.db, "minimum", duration=DAY)
        issue(self.db, "maximum", duration=315360000)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM activation_codes").fetchone()[0], 2)

    def test_payload_conflict_does_not_consume_second_code(self):
        """The stored request hash exposes a conflict without granting twice."""
        issue(self.db)
        issue(self.db, "other")
        redeem(self.db)
        redeem(self.db, "other")
        self.assertEqual(self.receipt()[0], "code")
        self.assertNotEqual(self.receipt()[0], "other")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM activation_redemptions").fetchone()[0], 1)
        redeem(self.db, "other", account="bob")
        self.assertIsNotNone(self.receipt("bob"))

    def test_extension_preserves_remaining_duration_and_receipt(self):
        """An active period keeps its start and adds the entire next grant."""
        issue(self.db)
        issue(self.db, "longer", duration=2 * DAY)
        redeem(self.db)
        before = self.receipt()
        redeem(self.db, "longer", key="second", now=NOW + 100)
        newer = self.receipt(key="second")[1]
        self.assertEqual(newer["current_period_start"], NOW)
        self.assertEqual(newer["current_period_end"], NOW + 3 * DAY)
        self.assertEqual(newer["id"], before[1]["id"])
        self.assertEqual(newer["entitlements"], ["basic"])
        self.assertEqual(self.receipt(), before)

    def test_active_different_plan_does_not_consume_code(self):
        """Switching an active product cannot silently replace its paid plan."""
        issue(self.db)
        issue(self.db, "plus-code", plan="plus")
        redeem(self.db)
        before = self.receipt()
        redeem(self.db, "plus-code", key="switch", now=NOW + 100)
        self.assertIsNone(self.receipt(key="switch"))
        self.assertEqual(self.receipt(), before)
        self.assertEqual(self.db.execute("SELECT plan_id,current_period_end FROM subscriptions WHERE account_id='alice'").fetchone(), ("basic", NOW + DAY))
        redeem(self.db, "plus-code", account="bob")
        self.assertEqual(self.receipt("bob")[1]["plan_id"], "plus")

    def test_expired_product_permits_plan_switch_at_boundary(self):
        """A different plan becomes usable exactly when the old period expires."""
        issue(self.db)
        issue(self.db, "plus-code", duration=2 * DAY, plan="plus", expires=NOW + 10 * DAY)
        redeem(self.db)
        before = self.receipt()
        redeem(self.db, "plus-code", key="switch", now=NOW + DAY)
        switched = self.receipt(key="switch")[1]
        self.assertEqual(switched["plan_id"], "plus")
        self.assertEqual(switched["entitlements"], ["plus"])
        self.assertEqual(switched["current_period_start"], NOW + DAY)
        self.assertEqual(switched["current_period_end"], NOW + 3 * DAY)
        self.assertEqual(switched["id"], before[1]["id"])
        self.assertEqual(self.receipt(), before)

    def test_expired_period_restarts_from_now(self):
        """Expired subscriptions get a new start and do not lose grant duration."""
        issue(self.db)
        issue(self.db, "later", expires=NOW + 10 * DAY)
        redeem(self.db)
        restart = NOW + 2 * DAY
        redeem(self.db, "later", key="second", now=restart)
        receipt = self.receipt(key="second")[1]
        self.assertEqual(receipt["current_period_start"], restart)
        self.assertEqual(receipt["current_period_end"], restart + DAY)

    def test_expiry_boundary_and_unknown_code(self):
        """Only strict future expiry is accepted by the actual Rust predicate."""
        for code, expiry in (("past", NOW - 1), ("boundary", NOW), ("future", NOW + 1)):
            issue(self.db, code, expires=expiry)
            redeem(self.db, code, key=code)
        redeem(self.db, "unknown", key="unknown")
        self.assertIsNone(self.receipt(key="past"))
        self.assertIsNone(self.receipt(key="boundary"))
        self.assertIsNone(self.receipt(key="unknown"))
        self.assertIsNotNone(self.receipt(key="future"))

    def test_trigger_failure_rolls_back_entire_grant(self):
        """Malformed stored entitlements cannot leave a consumed code or grant."""
        issue(self.db)
        self.db.execute("UPDATE activation_codes SET entitlements_json='invalid'")
        self.db.commit()
        with self.assertRaises(sqlite3.OperationalError):
            redeem(self.db)
        self.db.rollback()
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM activation_redemptions").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM subscriptions").fetchone()[0], 0)

    def test_principal_identity_unique_but_issuer_isolated(self):
        """Account identity is issuer plus subject, never an email join."""
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO billing_accounts VALUES('duplicate', 'https://identity.example', 'alice', '{}', ?, ?)", (NOW, NOW))
        self.db.execute("INSERT INTO billing_accounts VALUES('other-issuer', 'https://other.example', 'alice', '{}', ?, ?)", (NOW, NOW))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM billing_accounts").fetchone()[0], 3)

    def test_admin_send_claim_is_once_and_key_scoped(self):
        """Only a pending intent with its original secret fingerprint can send."""
        self.db.executescript((ROOT / "migrations/billing/0002_admin_issuance.sql").read_text(encoding="utf-8"))
        issue(self.db)
        self.db.execute(
            "INSERT INTO admin_issuance(issuance_id,plan_id,code_hash,key_fingerprint,created_at,updated_at) "
            "VALUES('intent', 'basic', 'code', 'original-key', ?, ?)", (NOW, NOW)
        )
        self.assertIsNone(self.db.execute(CLAIM_SQL, ("intent", NOW, "rotated-key")).fetchone())
        self.assertEqual(self.db.execute(CLAIM_SQL, ("intent", NOW, "original-key")).fetchone(), ("intent",))
        self.assertIsNone(self.db.execute(CLAIM_SQL, ("intent", NOW, "original-key")).fetchone())
        self.db.execute("UPDATE admin_issuance SET status='unknown' WHERE issuance_id='intent'")
        self.assertIsNone(self.db.execute(CLAIM_SQL, ("intent", NOW, "original-key")).fetchone())

    def test_concurrent_same_code_has_one_winner_and_durable_receipt(self):
        """Independent connections race through the exact INSERT, not a mock."""
        root = ROOT / ".temp"
        root.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="billing-sql-", dir=root) as directory:
            path = str(Path(directory) / "billing.sqlite")
            db = connect(path)
            try:
                initialize(db)
                issue(db)
            finally:
                db.close()
            barrier = threading.Barrier(2)

            def contender(account):
                """Start simultaneous writes from independent database clients."""
                db = connect(path)
                try:
                    barrier.wait(timeout=5)
                    redeem(db, account=account)
                    return db.execute(REPLAY_SQL, (account, "key")).fetchone()
                finally:
                    db.close()

            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                results = list(pool.map(contender, ("alice", "bob")))
            self.assertEqual(sum(result is not None for result in results), 1)
            db = connect(path)
            try:
                self.assertEqual(db.execute("SELECT COUNT(*) FROM subscriptions").fetchone()[0], 1)
                self.assertEqual(db.execute("SELECT COUNT(*) FROM activation_redemptions").fetchone()[0], 1)
            finally:
                db.close()


if __name__ == "__main__":
    unittest.main()

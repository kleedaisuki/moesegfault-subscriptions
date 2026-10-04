"""Validate administrator issuance and send arbitration against real SQLite."""

import sqlite3
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class IssuanceTests(unittest.TestCase):
    """Exercise idempotency constraints and irreversible send claims without mail."""

    def setUp(self):
        """Apply the actual repository migration stream to an isolated in-memory DB."""
        self.db = sqlite3.connect(":memory:")
        for migration in sorted((ROOT / "migrations" / "billing").glob("*.sql")):
            self.db.executescript(migration.read_text(encoding="utf-8"))

    def tearDown(self):
        """Release the fixture without generating files outside the workspace."""
        self.db.close()

    def create(self, intent, code_hash, plan):
        """Mirror the atomic production batch, including its duplicate-intent gate."""
        with self.db:
            self.db.execute(
                "INSERT INTO activation_codes "
                "SELECT ?,?,'product',86400,'[]',100,200 WHERE NOT EXISTS "
                "(SELECT 1 FROM admin_issuance WHERE issuance_id=?)",
                (code_hash, plan, intent),
            )
            self.db.execute(
                "INSERT OR IGNORE INTO admin_issuance "
                "(issuance_id,plan_id,code_hash,key_fingerprint,created_at,updated_at) "
                "VALUES(?,?,?,'key-fingerprint',100,100)",
                (intent, plan, code_hash),
            )

    def test_retry_does_not_mint_new_code(self):
        """Same and conflicting retries preserve the sole original snapshot."""
        self.create("intent", "hash-original", "pro")
        self.create("intent", "hash-original", "pro")
        self.create("intent", "hash-other", "other")
        self.assertEqual(self.db.execute("SELECT count(*) FROM activation_codes").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT plan_id FROM admin_issuance").fetchone()[0], "pro")

    def test_send_is_claimed_once_and_unknown_never_reclaims(self):
        """Duplicate requests cannot trigger duplicate provider calls after ambiguity."""
        self.create("intent", "hash-original", "pro")
        sql = "UPDATE admin_issuance SET status='sending' WHERE issuance_id=? AND status='pending' RETURNING issuance_id"
        self.assertEqual(self.db.execute(sql, ("intent",)).fetchone(), ("intent",))
        self.assertIsNone(self.db.execute(sql, ("intent",)).fetchone())
        self.db.execute("UPDATE admin_issuance SET status='unknown'")
        self.assertIsNone(self.db.execute(sql, ("intent",)).fetchone())

    def test_state_constraint_fails_closed(self):
        """A typo cannot silently introduce an automatically retryable state."""
        self.create("intent", "hash-original", "pro")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE admin_issuance SET status='delivered'")


if __name__ == "__main__":
    unittest.main()

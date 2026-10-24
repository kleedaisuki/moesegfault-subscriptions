"""Exercise production account queries and their domain ownership invariants."""

from __future__ import annotations

import json
from pathlib import Path
import re
import sqlite3
import unittest


ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "crates/billing/src/repository.rs").read_text(encoding="utf-8")


def query(prefix: str) -> str:
    match = re.search(r'"(' + re.escape(prefix) + r'[^"\n]+)"', SOURCE)
    if match is None:
        raise AssertionError(f"Missing production query: {prefix}")
    return match.group(1)


CREATE = query("INSERT INTO billing_accounts")
FIND = query("SELECT id,profile_json,created_at,updated_at FROM billing_accounts WHERE issuer=")
SAVE = query("UPDATE billing_accounts SET profile_json=")
NOW = 1_800_000_000
ISSUER = "https://identity.example"


class BillingAccountSqlTests(unittest.TestCase):
    db: sqlite3.Connection

    def setUp(self) -> None:
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        self.db.executescript(
            (ROOT / "migrations/billing/0001_billing.sql").read_text(encoding="utf-8")
        )

    def create(self, account: str = "alice", subject: str = "alice") -> tuple[object, ...] | None:
        return self.db.execute(CREATE, (account, ISSUER, subject, NOW)).fetchone()

    def test_first_login_returns_complete_account_without_followup_select(self) -> None:
        self.assertEqual(self.create(), ("alice", "{}", NOW, NOW))

    def test_racing_first_login_keeps_original_account_and_profile(self) -> None:
        self.create()
        profile = json.dumps({"city": "Singapore"})
        self.db.execute(SAVE, ("alice", profile, NOW + 1)).fetchone()
        self.assertIsNone(self.create("competing-id"))
        self.assertEqual(
            self.db.execute(FIND, (ISSUER, "alice")).fetchone(),
            ("alice", profile, NOW, NOW + 1),
        )
        self.assertEqual(self.db.total_changes, 2)

    def test_existing_account_lookup_never_writes(self) -> None:
        self.create()
        changes = self.db.total_changes
        for _ in range(10):
            self.assertIsNotNone(self.db.execute(FIND, (ISSUER, "alice")).fetchone())
        self.assertEqual(self.db.total_changes, changes)

    def test_profile_replacement_returns_own_write_and_can_clear_address(self) -> None:
        self.create()
        self.create("bob", "bob")
        profile = json.dumps({"address_line1": "123 Main Street", "city": "Singapore"})
        self.assertEqual(
            self.db.execute(SAVE, ("alice", profile, NOW + 1)).fetchone(),
            ("alice", profile, NOW, NOW + 1),
        )
        self.assertEqual(
            self.db.execute(SAVE, ("alice", "{}", NOW + 2)).fetchone(),
            ("alice", "{}", NOW, NOW + 2),
        )
        self.assertEqual(
            self.db.execute(FIND, (ISSUER, "bob")).fetchone(),
            ("bob", "{}", NOW, NOW),
        )

    def test_profile_is_account_owned_not_product_owned(self) -> None:
        self.create()
        for product in ("amail", "platform"):
            self.db.execute(
                "INSERT INTO subscriptions VALUES(?, 'alice', ?, 'monthly', ?, ?, '[]', 'activation_code')",
                (f"subscription-{product}", product, NOW, NOW + 86_400),
            )
        profile = json.dumps({"city": "Singapore"})
        self.db.execute(SAVE, ("alice", profile, NOW + 1)).fetchone()
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM billing_accounts").fetchone(), (1,))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM subscriptions").fetchone(), (2,))
        self.assertEqual(
            self.db.execute(
                "SELECT DISTINCT a.profile_json FROM subscriptions s JOIN billing_accounts a ON a.id=s.account_id"
            ).fetchall(),
            [(profile,)],
        )

    def test_unknown_account_update_cannot_create_another_profile(self) -> None:
        self.assertIsNone(self.db.execute(SAVE, ("unknown", "{}", NOW)).fetchone())
        self.assertEqual(self.db.total_changes, 0)

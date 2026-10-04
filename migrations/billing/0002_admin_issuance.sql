-- An immutable intent snapshots one activation code without storing bearer material.
CREATE TABLE admin_issuance (
  issuance_id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE REFERENCES activation_codes(code_hash),
  key_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','unknown')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- Atomic uniqueness arbitrates simultaneous issuance requests. Email sending is claimed once.

-- Login transactions are browser-bound, short-lived, and consumed atomically.
CREATE TABLE subscribe_login (
 state_hash TEXT PRIMARY KEY,
 browser_hash TEXT NOT NULL,
 nonce TEXT NOT NULL,
 verifier TEXT NOT NULL,
 return_to TEXT,
 local_path TEXT NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE INDEX subscribe_login_expiry ON subscribe_login(expires_at);
-- Only hashes of opaque browser session IDs are stored; OAuth tokens stay server-side.
CREATE TABLE subscribe_sessions (
 session_hash TEXT PRIMARY KEY,
 subject TEXT NOT NULL,
 name TEXT,
 access_token TEXT NOT NULL,
 csrf TEXT NOT NULL,
 return_to TEXT,
 expires_at INTEGER NOT NULL
);
CREATE INDEX subscribe_sessions_expiry ON subscribe_sessions(expires_at);

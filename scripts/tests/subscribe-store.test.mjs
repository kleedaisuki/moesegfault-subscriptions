/** Exercise the actual Worker SQL against SQLite without starting a dev server. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const schema = readFileSync(new URL('../../migrations/subscribe/0001_sessions.sql', import.meta.url), 'utf8');
const source = readFileSync(new URL('../../crates/subscribe/src/store.rs', import.meta.url), 'utf8');
const consumeSql = source.match(/prepare\("(DELETE FROM subscribe_login[^"\n]+)"\)/)?.[1];
const sessionSql = source.match(/prepare\("(SELECT session_hash[^"\n]+)"\)/)?.[1];

/** Fresh in-memory storage keeps tests cheap and independent of deployment secrets. */
function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  return db;
}

test('actual login consumption SQL binds the browser and is single-use', () => {
  assert.ok(consumeSql, 'Worker consume SQL must remain inspectable');
  const db = database();
  try {
    db.prepare('INSERT INTO subscribe_login(state_hash,browser_hash,nonce,verifier,return_to,local_path,expires_at) VALUES (?,?,?,?,?,?,?)').run('statehash', 'browserhash', 'nonce', 'verifier', null, '/', 200);
    const consume = db.prepare(consumeSql);
    assert.equal(consume.get('statehash', 'another-browser', 100), undefined);
    assert.equal(consume.get('another-state', 'browserhash', 100), undefined);
    assert.deepEqual({ ...consume.get('statehash', 'browserhash', 100) }, { nonce: 'nonce', verifier: 'verifier', return_to: null, local_path: '/' });
    assert.equal(consume.get('statehash', 'browserhash', 100), undefined);
  } finally { db.close(); }
});

test('expired transactions cannot be consumed, including exact expiry boundary', () => {
  const db = database();
  try {
    db.prepare('INSERT INTO subscribe_login(state_hash,browser_hash,nonce,verifier,return_to,local_path,expires_at) VALUES (?,?,?,?,?,?,?)').run('statehash', 'browserhash', 'nonce', 'verifier', null, '/', 200);
    assert.equal(db.prepare(consumeSql).get('statehash', 'browserhash', 200), undefined);
    assert.equal(db.prepare(consumeSql).get('statehash', 'browserhash', 201), undefined);
  } finally { db.close(); }
});

test('actual session lookup enforces expiry and hash ownership on every read', () => {
  assert.ok(sessionSql, 'Worker session lookup SQL must remain inspectable');
  const db = database();
  try {
    db.prepare('INSERT INTO subscribe_sessions(session_hash,subject,name,access_token,csrf,return_to,expires_at) VALUES (?,?,?,?,?,?,?)').run('sessionhash', 'pairwise-sub', 'Verified display name', 'server-token', 'csrf', null, 200);
    const query = db.prepare(sessionSql);
    assert.equal(query.get('anotherhash', 100), undefined);
    assert.equal(query.get('sessionhash', 200), undefined);
    assert.equal(query.get('sessionhash', 199).subject, 'pairwise-sub');
    assert.equal(query.get('sessionhash', 199).name, 'Verified display name');
  } finally { db.close(); }
});

/** Private local administrator-key creation; never exports key material to stdout. */
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, lstatSync, writeFileSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const secretDirectory = join(root, '.secrets');
export const keyPath = join(secretDirectory, 'billing-admin-key');

/** Reject symbolic links and grant access only to the current OS account. */
export function protect(path, directory = false) {
  if (lstatSync(path).isSymbolicLink()) throw new Error('unsafe_local_path');
  if (process.platform !== 'win32') {
    chmodSync(path, directory ? 0o700 : 0o600);
    return;
  }
  const identity = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' });
  const sid = identity.match(/S-1-\d+(?:-\d+)+/u)?.[0];
  if (!sid) throw new Error('local_identity_unavailable');
  execFileSync('icacls', [path, '/inheritance:r', '/grant:r', `*${sid}:${directory ? '(OI)(CI)' : ''}F`], { stdio: 'ignore' });
}

/** Initialize the ignored directory before putting any private material in it. */
export function prepareSecrets() {
  execFileSync('git', ['check-ignore', '--quiet', '.secrets/billing-admin-key'], { cwd: root, stdio: 'ignore' });
  mkdirSync(secretDirectory, { recursive: true, mode: 0o700 });
  protect(secretDirectory, true);
}

/** Create once: existing deployment credentials must never be silently rotated. */
export function initializeKey() {
  prepareSecrets();
  try {
    writeFileSync(keyPath, randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 });
    protect(keyPath);
    return 'created';
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    protect(keyPath);
    return 'existing';
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).join(' ') !== '--init') {
    console.error('Usage: node scripts/admin-key.mjs --init');
    process.exitCode = 1;
  } else {
    try { console.log(`Administrator key: ${initializeKey()}. Key material is never displayed.`); }
    catch { console.error('Administrator key setup failed. Check Git ignore and local file permissions.'); process.exitCode = 1; }
  }
}

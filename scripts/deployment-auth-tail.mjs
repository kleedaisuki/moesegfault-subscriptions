#!/usr/bin/env node
/**
 * Stream only allowlisted staging authentication categories; never forward raw tail output.
 * Usage: node scripts/deployment-auth-tail.mjs subscribe [--once]
 * Runtime is bounded to ten minutes. URLs, request metadata, exceptions and unknown logs are dropped.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const stages = ['policy', 'token_size', 'compact', 'header_json', 'header_policy', 'claims_json', 'issuer', 'token_kind', 'subject_format', 'token_time', 'nonce', 'audience', 'authorized_party', 'scope', 'claims_policy', 'signature_encoding', 'signature_size', 'jwks', 'webcrypto', 'signature_mismatch'];
const categories = ['invalid_identity_credentials', 'insufficient_identity_scope', 'identity_configuration_error', 'identity_verification_unavailable'];
const allowed = new RegExp(`^(?:\\((?:warn|log|info|error)\\)\\s+)?(identity_verification_rejected stage=(?:${stages.join('|')}) category=(?:${categories.join('|')}))$`);

/** Return one fixed-enum diagnostic only; arbitrary context cannot pass the anchored allowlist. */
export function sanitizeDiagnostic(line) {
  if (typeof line !== 'string' || line.length > 512) return null;
  const plain = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
  return allowed.exec(plain)?.[1] ?? null;
}

/** Pipe Wrangler privately and end on timeout, interrupt, error, or the requested first category. */
function main() {
  const [service, option, extra] = process.argv.slice(2);
  if (!['subscribe', 'billing'].includes(service) || extra || (option && option !== '--once')) throw new Error('Usage: deployment-auth-tail.mjs <subscribe|billing> [--once]');
  const child = spawn(process.execPath, [
    'node_modules/wrangler/bin/wrangler.js', 'tail', '--config', `wrangler.${service}.jsonc`,
    '--format', 'pretty', '--search', 'identity_verification_rejected',
  ], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WRANGLER_WRITE_LOGS: 'false', WRANGLER_LOG_SANITIZE: 'true' },
  });
  // Never inherit either child stream: even an otherwise unrelated invocation contains its full URL.
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  const stop = () => child.kill();
  const timeout = setTimeout(stop, 600_000);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  lines.on('line', (line) => {
    const safe = sanitizeDiagnostic(line);
    if (safe) {
      process.stdout.write(`${service}: ${safe}\n`);
      if (option === '--once') stop();
    }
    if (/Successfully created tail|Connected to/.test(line)) process.stdout.write(`Sanitized staging ${service} tail connected.\n`);
  });
  child.on('error', () => { process.stderr.write('Sanitized tail could not start.\n'); process.exitCode = 1; });
  child.on('exit', (code, signal) => {
    clearTimeout(timeout);
    lines.close();
    if (code && !signal) {
      process.exitCode = 1;
      process.stderr.write('Sanitized tail ended; inspect authentication separately, not raw callback logs.\n');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

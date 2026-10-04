/** Verify metadata request construction against real workerd, not Node's Fetch API. */
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("JWT metadata uses workerd-compatible redirect rejection", async () => {
  const source = await readFile(path.join(root, "crates/billing/src/auth.rs"), "utf8");
  const mode = source.match(/init\.with_redirect\(RequestRedirect::(Manual|Error|Follow)\)/)?.[1];
  assert.equal(mode, "Manual", "metadata must not follow redirects or use unsupported error mode");
  assert.match(source, /if response\.status_code\(\) != 200/,
    "manual responses must reject every redirect before parsing metadata");

  // Keep all simulator scratch files in the repository's explicitly ignored directory.
  const scratch = path.join(root, ".temp", "auth-runtime-test");
  await mkdir(scratch, { recursive: true });
  const previous = Object.fromEntries(["TMP", "TEMP", "TMPDIR"].map((key) => [key, process.env[key]]));
  for (const key of Object.keys(previous)) process.env[key] = scratch;
  const { Miniflare } = await import("miniflare");
  const script = `export default { fetch() {
    let errorRejected = false;
    try { new Request("https://metadata.test", {redirect: "error"}); }
    catch { errorRejected = true; }
    const request = new Request("https://metadata.test", {redirect: ${JSON.stringify(mode.toLowerCase())}});
    return Response.json({errorRejected, redirect: request.redirect});
  } };`;
  const runtime = new Miniflare({
    workers: [{ config: {
      name: "auth-metadata-conformance",
      compatibilityDate: "2026-09-15",
      manifest: { mainModule: "index.mjs", modules: { "index.mjs": { type: "esm", contents: script } } },
    } }],
    cf: false,
    resourcePersistencePath: scratch,
  });
  try {
    const response = await runtime.dispatchFetch("https://conformance.test");
    assert.deepEqual(await response.json(), { errorRejected: true, redirect: "manual" });
  } finally {
    await runtime.dispose();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

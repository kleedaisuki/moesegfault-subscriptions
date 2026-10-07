/** Guard the patched native image toolchain without downgrading Cloudflare deployment APIs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the reviewed sharp patch is pinned while Wrangler retains its supported version',()=>{
  const manifest=JSON.parse(readFileSync(new URL('../../package.json',import.meta.url),'utf8'));
  const lock=JSON.parse(readFileSync(new URL('../../package-lock.json',import.meta.url),'utf8'));
  assert.equal(manifest.overrides.sharp,'0.35.5');
  assert.equal(manifest.devDependencies.wrangler,'4.147.0');
  assert.equal(lock.packages['node_modules/sharp'].version,'0.35.5');
  assert.equal(lock.packages['node_modules/wrangler'].version,'4.147.0');
});

test('patched sharp loads its native binary and rasterizes a bounded trusted SVG',async()=>{
  const {default:sharp}=await import('sharp');
  assert.equal(sharp.versions.sharp,'0.35.5');
  const input=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>');
  const {info}=await sharp(input).png().toBuffer({resolveWithObject:true});
  assert.equal(info.width,2); assert.equal(info.height,2); assert.equal(info.format,'png');
});

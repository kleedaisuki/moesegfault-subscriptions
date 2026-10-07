/** Apply actual pinned Wrangler split output, not only unsplit SQLite migration scripts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync,readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {unstable_splitSqlQuery}=require('wrangler');

/** Read repository SQL while retaining the deployment tool's real lexer and statement boundaries. */
function migration(folder,name) { return readFileSync(new URL(`../../migrations/${folder}/${name}`,import.meta.url),'utf8'); }

test('pinned Wrangler splits every Billing and Subscribe migration into executable complete statements',()=>{
  assert.equal(require('wrangler/package.json').version,'4.147.0');
  assert.equal(typeof unstable_splitSqlQuery,'function');
  for(const folder of ['billing','subscribe']) {
    const db=new DatabaseSync(':memory:');
    const files=readdirSync(new URL(`../../migrations/${folder}/`,import.meta.url)).filter(n=>n.endsWith('.sql')).sort();
    for(const file of files) {
      const parts=unstable_splitSqlQuery(migration(folder,file));
      assert.ok(parts.length>0);
      for(const sql of parts) assert.doesNotThrow(()=>db.exec(sql),`${folder}/${file} must remain complete after Wrangler splitting`);
    }
    db.close();
  }
});

test('new amail trigger guards avoid ambiguous CASE END statements at the D1 service boundary',()=>{
  for(const file of ['0003_amail_authorizations.sql','0004_amail_usage.sql','0006_amail_usd.sql']) {
    const sql=migration('billing',file).replace(/--[^\n]*/g,'');
    assert.doesNotMatch(sql,/\bCASE\b/i,'Use SELECT RAISE WHERE guards instead of adding a second END to triggers');
    const triggers=unstable_splitSqlQuery(sql).filter(part=>/CREATE\s+TRIGGER/i.test(part));
    assert.ok(triggers.length>0);
    assert.ok(triggers.every(part=>(part.match(/\bEND\b/gi)||[]).length===1));
  }
});

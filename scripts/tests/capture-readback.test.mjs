/** Exercise the exact metadata reader with provider fixtures; never use deployment credentials. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {verifyCaptureSettings} from '../deployment-capture-readback.mjs';
const require=createRequire(import.meta.url);
const account='1'.repeat(32);const id='11111111-1111-4111-8111-111111111111';

/** Fixed fixture records only safe request semantics and returns realistic metadata shapes. */
function provider(change=()=>{}){
  const requests=[];
  const fetcher=async(url,options)=>{
    requests.push({url,method:options.method,redirect:options.redirect});
    const script=/moesegfault-(billing|subscribe)-staging/.exec(url)?.[0];assert.ok(script);
    let result;
    if(url.includes('/deployments?'))result={deployments:[{id,strategy:'percentage',versions:[{version_id:id,percentage:100}]}]};
    else if(url.includes('/workers/workers/'))result={id,name:script,logpush:false,tail_consumers:[],observability:{enabled:false,logs:{enabled:false,invocation_logs:false},traces:{enabled:false},issues:{enabled:false}}};
    else result={observability:null};
    change(result,url);
    return new Response(JSON.stringify({success:true,result}));
  };
  return {fetcher,requests};
}

test('pinned Wrangler accepts explicit staging Issues-off without changing production intent',()=>{
  const {unstable_readConfig}=require('wrangler');
  for(const service of ['billing','subscribe']){
    const config=unstable_readConfig({config:`wrangler.${service}.jsonc`});
    assert.equal(config.observability.issues.enabled,false);
    assert.equal(config.observability.logs.enabled,false);
    assert.equal(config.observability.traces.enabled,false);
  }
});

test('metadata readback emits only closed flags and version IDs using fixed read-only paths',async()=>{
  const {fetcher,requests}=provider();
  const rows=await verifyCaptureSettings({account,token:'synthetic-token',fetcher});
  assert.equal(rows.length,2);assert.equal(requests.length,10);
  assert.ok(requests.every(v=>v.method==='GET'&&v.redirect==='error'&&v.url.startsWith(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/`)));
  assert.deepEqual(Object.keys(rows[0]),['service','version_id','capture']);
  assert.deepEqual(rows[0].capture,{enabled:false,logs:false,invocation_logs:false,traces:false,issues:false});
  assert.ok(!JSON.stringify(rows).includes('synthetic-token'));
});

test('missing or enabled independent Issues is unverified, never inferred from global disabled',async()=>{
  for(const issues of [undefined,{enabled:true}]){
    const {fetcher}=provider(row=>{if(row.observability)row.observability.issues=issues;});
    await assert.rejects(()=>verifyCaptureSettings({account,token:'synthetic-token',fetcher}),/policy unverified/);
  }
});

test('reader rejects redirects and raw provider error bodies without printing them',async()=>{
  await assert.rejects(()=>verifyCaptureSettings({account,token:'synthetic-token',fetcher:async()=>new Response('private-provider-body',{status:403})}),error=>!error.message.includes('private-provider-body')&&!error.message.includes('synthetic-token'));
});

test('staging pipeline verifies independent capture settings after deploy and before human-facing smoke',async()=>{
  const {readFileSync}=await import('node:fs');
  const release=readFileSync(new URL('../deployment-release.mjs',import.meta.url),'utf8');
  assert.ok(release.indexOf("await import('./deployment-capture-readback.mjs')")>release.indexOf("wrangler('deploy'"));
  assert.ok(release.indexOf("await import('./deployment-capture-readback.mjs')")<release.indexOf("await import('./deployment-smoke.mjs')"));
  assert.ok(release.includes("if (target === 'staging')"));
});

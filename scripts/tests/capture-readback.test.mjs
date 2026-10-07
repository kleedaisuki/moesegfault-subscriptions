/** Exercise the exact metadata reader with provider fixtures; never use deployment credentials. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {verifyCaptureSettings} from '../deployment-capture-readback.mjs';
const require=createRequire(import.meta.url);
const account='1'.repeat(32);const id='11111111-1111-4111-8111-111111111111';

/** Fixed fixture records only safe request semantics and returns realistic metadata shapes. */
function provider(change=()=>{},target='staging'){
  const requests=[];
  const fetcher=async(url,options)=>{
    requests.push({url,method:options.method,redirect:options.redirect});
    const script=/moesegfault-(billing|subscribe)(?:-staging)?/.exec(url)?.[0];assert.ok(script);
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

test('present unknown or enabled independent Issues is unverified, never inferred from global disabled',async()=>{
  for(const issues of [{},{enabled:true}]){
    const {fetcher}=provider(row=>{if(row.observability)row.observability.issues=issues;});
    await assert.rejects(()=>verifyCaptureSettings({account,token:'synthetic-token',fetcher}),/Issues capture unverified/);
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
  assert.ok(release.includes('token: process.env.CLOUDFLARE_API_TOKEN, target}'));
});

test('read-only diagnosis preserves missing flags for all three sources without rebuilding or deploying',async()=>{
  const {inspectCaptureSettings}=await import('../deployment-capture-readback.mjs');
  const {readFileSync}=await import('node:fs');
  const {fetcher,requests}=provider(row=>{if(row.observability)delete row.observability.issues;});
  const rows=await inspectCaptureSettings({account,token:'synthetic-token',fetcher});
  assert.equal(rows[0].sources.current_worker.issues,'missing');
  assert.deepEqual(rows[0].sources.legacy_settings,{enabled:'missing',logs:'missing',invocation_logs:'missing',traces:'missing',issues:'missing'});
  assert.ok(requests.every(v=>v.method==='GET'));
  const workflow=readFileSync(new URL('../../.github/workflows/ci.yml',import.meta.url),'utf8');
  const job=workflow.slice(workflow.indexOf('  capture_readback:'),workflow.indexOf('  production:'));
  assert.ok(job.includes("inputs.delivery == 'capture-readback-only'"));
  assert.ok(job.includes('node scripts/deployment-capture-diagnose.mjs'));
  assert.ok(!job.includes('deploy:staging')&&!job.includes('npm ci')&&!job.includes('worker-build'));
  assert.equal((workflow.match(/inputs.delivery != 'capture-readback-only'/g)||[]).length,3);
});


test('documented Issues section absence is off only with explicit root Logs and Traces disabled',async()=>{
  const {fetcher}=provider(row=>{if(row.observability){delete row.observability.issues;row.observability.logs.invocation_logs=true;}});
  const rows=await verifyCaptureSettings({account,token:'synthetic-token',fetcher});
  assert.equal(rows[0].capture.issues,'disabled_by_optin_absence');
  assert.equal(rows[0].capture.invocation_logs,true,'Preference is reported as observed, not rewritten false');
  for(const missing of ['enabled','logs','traces']){
    const unsafe=provider(row=>{if(row.observability){delete row.observability[missing];delete row.observability.issues;}});
    await assert.rejects(()=>verifyCaptureSettings({account,token:'synthetic-token',fetcher:unsafe.fetcher}),/policy unverified/);
  }
  const logsOn=provider(row=>{if(row.observability){row.observability.logs.enabled=true;delete row.observability.issues;}});
  await assert.rejects(()=>verifyCaptureSettings({account,token:'synthetic-token',fetcher:logsOn.fetcher}),/policy unverified/);
});


test('production capture readback selects only production names and rejects unknown realms',async()=>{
  const {fetcher,requests}=provider(()=>{},'production');
  const rows=await verifyCaptureSettings({account,token:'synthetic-token',fetcher,target:'production'});
  assert.equal(rows.length,2);
  assert.ok(requests.every(row=>!row.url.includes('-staging')));
  await assert.rejects(()=>verifyCaptureSettings({account,token:'synthetic-token',fetcher,target:'unknown'}),/realm unverified/);
});

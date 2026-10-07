/** Read only fixed staging capture metadata; never print provider bodies, bindings or credentials. */
const API='https://api.cloudflare.com/client/v4';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Fetch one bounded read-only provider object with a fixed timeout and no credential redirects. */
async function read(account,token,path,fetcher){
  try{
    const response=await fetcher(`${API}/accounts/${account}/workers/${path}`,{method:'GET',redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:`Bearer ${token}`,Accept:'application/json'}});
    if(response.status!==200)throw new Error();
    const reader=response.body.getReader();let total=0;const chunks=[];
    for(;;){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>262144){await reader.cancel();throw new Error();}chunks.push(Buffer.from(value));}
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(body.success!==true || !body.result || typeof body.result!=='object' || Array.isArray(body.result))throw new Error();
    return body.result;
  }catch{throw new Error('Staging capture metadata unavailable or malformed.');}
}

/** Require one fully serving immutable version, not a split rollout or a preview configuration. */
function serving(value){
  const current=value.deployments?.[0];const versions=current?.versions;
  if(current?.strategy!=='percentage' || !UUID.test(current.id) || !Array.isArray(versions) || versions.length!==1 || versions[0].percentage!==100 || !UUID.test(versions[0].version_id))throw new Error('Staging capture deployment unverified.');
  return {deployment_id:current.id,version_id:versions[0].version_id};
}

/** Require explicit root/Logs/Traces off; only the documented opt-in Issues section may be absent. */
function flags(value){
  if(!value || value.enabled!==false || value.logs?.enabled!==false || value.traces?.enabled!==false)throw new Error('Staging capture-off policy unverified.');
  const issuesAbsent=!Object.hasOwn(value,'issues');
  if(!issuesAbsent && value.issues?.enabled!==false)throw new Error('Staging independent Issues capture unverified.');
  if(value.logs.invocation_logs!=null && typeof value.logs.invocation_logs!=='boolean')throw new Error('Staging invocation preference unverified.');
  for(const section of [value.logs,value.traces])if(section.destinations?.some(v=>v!=='cloudflare'))throw new Error('Staging capture exports unverified.');
  return {enabled:false,logs:false,invocation_logs:value.logs.invocation_logs??'missing',traces:false,issues:issuesAbsent?'disabled_by_optin_absence':false};
}

/** Partial legacy views cannot contradict the authoritative exact current Worker resource. */
function noncontradictory(value){
  if(value.logpush===true || value.tail_consumers?.length || value.streaming_tail_consumers?.length)throw new Error('Staging capture exports unverified.');
  const obs=value.observability;
  if(obs && (obs.enabled===true || obs.logs?.enabled===true || obs.traces?.enabled===true || obs.issues?.enabled===true))throw new Error('Staging capture legacy metadata contradicts current policy.');
}

/** Verify both fixed staging workers and return only sanitized flags plus immutable version IDs. */
export async function verifyCaptureSettings({account,token,fetcher=fetch}){
  if(!/^[0-9a-f]{32}$/.test(account??'') || typeof token!=='string' || !token)throw new Error('Staging capture readback credentials unavailable.');
  const results=[];
  for(const service of ['billing','subscribe']){
    const script=`moesegfault-${service}-staging`;
    const before=serving(await read(account,token,`scripts/${script}/deployments?per_page=1&page=1`,fetcher));
    const worker=await read(account,token,`workers/${script}`,fetcher);
    if(worker.name!==script || typeof worker.id!=='string' || !worker.id || worker.logpush!==false || !Array.isArray(worker.tail_consumers) || worker.tail_consumers.length || worker.streaming_tail_consumers?.length)throw new Error('Staging current Worker capture resource unverified.');
    const capture=flags(worker.observability);
    noncontradictory(await read(account,token,`scripts/${script}/settings`,fetcher));
    noncontradictory(await read(account,token,`scripts/${script}/script-settings`,fetcher));
    const after=serving(await read(account,token,`scripts/${script}/deployments?per_page=1&page=1`,fetcher));
    if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('Staging serving deployment changed during capture readback.');
    results.push({service,version_id:before.version_id,capture});
  }
  return results;
}

/** Project only explicit booleans; absent provider fields stay visibly missing, never inferred false. */
function projectedFlags(value){
  const flag=value=>{if(value==null)return 'missing';if(typeof value!=='boolean')throw new Error('Staging capture flag type unverified.');return value;};
  return {enabled:flag(value?.enabled),logs:flag(value?.logs?.enabled),invocation_logs:flag(value?.logs?.invocation_logs),traces:flag(value?.traces?.enabled),issues:flag(value?.issues?.enabled)};
}

/** Pure read-only diagnosis of all three fixed provider views, without claiming capture-off acceptance. */
export async function inspectCaptureSettings({account,token,fetcher=fetch}){
  if(!/^[0-9a-f]{32}$/.test(account??'') || typeof token!=='string' || !token)throw new Error('Staging capture readback credentials unavailable.');
  const result=[];
  for(const service of ['billing','subscribe']){
    const script=`moesegfault-${service}-staging`;
    const before=serving(await read(account,token,`scripts/${script}/deployments?per_page=1&page=1`,fetcher));
    const worker=await read(account,token,`workers/${script}`,fetcher);
    if(worker.name!==script || typeof worker.id!=='string' || !worker.id)throw new Error('Staging capture resource identity unverified.');
    const legacy=await read(account,token,`scripts/${script}/settings`,fetcher);
    const scriptSettings=await read(account,token,`scripts/${script}/script-settings`,fetcher);
    const after=serving(await read(account,token,`scripts/${script}/deployments?per_page=1&page=1`,fetcher));
    if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('Staging serving deployment changed during capture readback.');
    result.push({service,version_id:before.version_id,sources:{current_worker:projectedFlags(worker.observability),legacy_settings:projectedFlags(legacy.observability),script_settings:projectedFlags(scriptSettings.observability)}});
  }
  return result;
}

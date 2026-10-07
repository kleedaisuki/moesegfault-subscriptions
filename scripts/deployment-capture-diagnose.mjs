#!/usr/bin/env node
/** Read-only operator entrypoint; emits only closed flags and immutable version IDs. */
import {inspectCaptureSettings} from './deployment-capture-readback.mjs';
try{
  if(process.argv.length!==2)throw new Error('Read-only capture diagnosis accepts no arguments.');
  const rows=await inspectCaptureSettings({account:process.env.CLOUDFLARE_ACCOUNT_ID,token:process.env.CLOUDFLARE_API_TOKEN});
  for(const row of rows)process.stdout.write(`Staging capture diagnosis: ${JSON.stringify(row)}\n`);
}catch{process.stderr.write('Staging capture read-only diagnosis unavailable or unverified.\n');process.exitCode=1;}

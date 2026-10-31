#!/usr/bin/env node
// Runs only in a dedicated fleet shell. Credential bytes arrive through private file upload.
import { readFile, writeFile, mkdir, rename, chmod, lstat, readlink, realpath, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
const [candidateFile,probeKey,receiptFile,expectedFile]=process.argv.slice(2);
const home=os.homedir(), expand=s=>s.startsWith('~/')?path.join(home,s.slice(2)):s;
const roots=[['codex',expand(process.env.CODEX_HOME||path.join(home,'.codex')),'AGENTS.md'],['claude',expand(process.env.CLAUDE_CONFIG_DIR||path.join(home,'.claude')),'CLAUDE.md'],['pi',expand(process.env.PI_CODING_AGENT_DIR||path.join(home,'.pi/agent')),'AGENTS.md']];
const skill=path.join(roots[0][1],'skills/tmax-drafts');
const {loadCredentials,sendR2,uploadFile}=await import(pathToFileURL(path.join(skill,'scripts/upload-asset.mjs')));
const {ASSET_ACCOUNT,ASSET_BUCKET}=await import(pathToFileURL(path.join(skill,'scripts/asset-contract.mjs')));
const sha=b=>createHash('sha256').update(b).digest('hex');
const target=path.join(home,'.config/tmux-mobile/draft-assets.json');
const check=async c=>{const r=await sendR2(c,'HEAD',probeKey,{},Buffer.alloc(0));return r.status===200;};
const expected=JSON.parse(await readFile(expectedFile,'utf8'));
let credentials,source;
try {const c=await loadCredentials(target);if(await check(c)){credentials=c;source='existing-draft-credential';}} catch {}
if(!credentials) {
  try {
    const envFile=await readFile(path.join(home,'cloudflare.env'),'utf8'), values={};
    for(const line of envFile.split('\n')) {const m=line.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*?)\s*$/);if(m)values[m[1]]=m[2].replace(/^['"]|['"]$/g,'');}
    if(values.CLOUDFLARE_ACCOUNT_ID===ASSET_ACCOUNT && /^[A-Za-z0-9_-]+$/.test(values.CLOUDFLARE_API_TOKEN||'')) {
      const r=await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify',{headers:{authorization:`Bearer ${values.CLOUDFLARE_API_TOKEN}`},redirect:'error',signal:AbortSignal.timeout(20000)});
      const info=await r.json();
      if(r.ok&&info.result?.status==='active') {
        const c={accountId:ASSET_ACCOUNT,bucket:ASSET_BUCKET,accessKeyId:info.result.id,secretAccessKey:sha(values.CLOUDFLARE_API_TOKEN)};
        if(await check(c)){credentials=c;source='existing-local-cloudflare-token';}
      }
    }
  } catch {}
}
if(!credentials) {credentials=await loadCredentials(candidateFile);if(!await check(credentials))throw Error('Approved credential cannot read the fixed bucket');source='privately-copied-approved-credential';}
await mkdir(path.dirname(target),{recursive:true,mode:0o700});
if(source!=='existing-draft-credential') {
  const previous=await readFile(target).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(previous){const backup=target+'.backup-'+Date.now();await writeFile(backup,previous,{mode:0o600});}
  const temp=target+'.tmp-'+process.pid;await writeFile(temp,JSON.stringify(credentials,null,2)+'\n',{mode:0o600});await rename(temp,target);
}
await chmod(target,0o600);await unlink(candidateFile);
const config=JSON.parse(await readFile(process.env.TMUX_MOBILE_AGENT_CONFIG||path.join(home,'.config/tmux-mobile/agent.json'),'utf8'));
const entry=config.controllers?.['https://eng.impo.ai']||config.controllers?.['https://eng.xyznot.com'];
if(!entry?.token||!entry?.agentId)throw Error('No Connector identity for upload verification');
const response=await fetch('https://eng.xyznot.com/agent/drafts?context=1',{headers:{authorization:`Bearer ${entry.token}`,'x-agent-id':entry.agentId},redirect:'error',signal:AbortSignal.timeout(30000)});
if(!response.ok)throw Error('Could not identify upload machine');
const context=await response.json();
const testFile=receiptFile+'.txt';await writeFile(testFile,'T-MAX Draft asset fleet verification\n',{mode:0o600});
const uploaded=await uploadFile(testFile,context.machineId,(...args)=>sendR2(credentials,...args));await unlink(testFile);
const skills=[];
for(const [agent,root] of roots) for(const [name,files] of Object.entries(expected.skills)) {
  let ok=true;for(const [relative,digest] of Object.entries(files)){try{if(sha(await readFile(path.join(root,'skills',name,relative)))!==digest)ok=false;}catch{ok=false;}}
  skills.push({agent,skill:name,verified:ok});
}
const canonical=path.join(home,'.config/agent-instructions/AGENTS.md');
const globalInstructions=[];
for(const [agent,root,name] of roots){
  const file=path.join(root,name);try{
    const info=await lstat(file),resolved=await realpath(file),hash=sha(await readFile(file));
    globalInstructions.push({agent,path:file,symlink:info.isSymbolicLink(),target:info.isSymbolicLink()?await readlink(file):null,resolved,sha256:hash,verified:info.isSymbolicLink()&&resolved===await realpath(canonical)&&hash===expected.globalInstructionSha256});
  }catch(error){globalInstructions.push({agent,verified:false,error:error.code||'unavailable'});}
}
const receipt={credentialFile:target,credentialMode:(await lstat(target)).mode&0o777,credentialSha256:sha(await readFile(target)),credentialSource:source,upload:uploaded,skills,globalInstructions};
await writeFile(receiptFile,JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
console.log('Draft asset provisioning and upload verified; private receipt saved.');

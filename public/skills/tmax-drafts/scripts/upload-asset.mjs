#!/usr/bin/env node
// No dependencies. Stream files to the one R2 bucket; never embed credentials in HTML.
import { createHash, createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, open, realpath } from 'node:fs/promises';
import { request } from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSET_ACCOUNT, ASSET_BUCKET, ASSET_ORIGIN, ASSET_TYPES } from './asset-contract.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const xmlEscape = s => String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
const xmlValue = (xml, name) => xml.match(new RegExp(`<${name}>([^<]+)</${name}>`))?.[1]?.replaceAll('&quot;','"').replaceAll('&amp;','&');
export function signedRequest(credentials, method, key, query = {}, body = Buffer.alloc(0), extraHeaders = {}, now = new Date()) {
  const host = `${ASSET_ACCOUNT}.r2.cloudflarestorage.com`;
  const pathname = '/' + [ASSET_BUCKET, ...key.split('/')].map(encode).join('/');
  const search = Object.entries(query).map(([k,v]) => [encode(k),encode(v)]).sort((a,b) => a[0].localeCompare(b[0])).map(([k,v])=>`${k}=${v}`).join('&');
  const date = now.toISOString().replace(/[-:]|\.\d{3}/g,''), day = date.slice(0,8);
  const payloadHash = sha(body);
  const headers = {host, 'x-amz-date':date, 'x-amz-content-sha256':payloadHash, ...extraHeaders};
  const names = Object.keys(headers).sort();
  const scope = `${day}/auto/s3/aws4_request`;
  const canonical = [method,pathname,search,names.map(k=>`${k}:${String(headers[k]).trim()}\n`).join(''),names.join(';'),payloadHash].join('\n');
  const signing = hmac(hmac(hmac(hmac('AWS4'+credentials.secretAccessKey,day),'auto'),'s3'),'aws4_request');
  const signature = hmac(signing,`AWS4-HMAC-SHA256\n${date}\n${scope}\n${sha(canonical)}`).toString('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
  return {method, hostname:host, path:pathname+(search?'?'+search:''), headers:{...headers,'content-length':body.length}, body};
}
export async function sendR2(credentials, method, key, query, body, headers = {}) {
  const options = signedRequest(credentials,method,key,query,body,headers);
  return new Promise((resolve,reject) => {
    const req = request(options, res => {
      const chunks=[]; let length=0;
      res.on('data',chunk=>{ length+=chunk.length; if(length>1024*1024) res.destroy(Error('R2 response too large')); else chunks.push(chunk); });
      res.on('error',reject);
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text:Buffer.concat(chunks).toString()}));
    });
    req.on('error',()=>reject(Error('R2 network request failed')));
    req.setTimeout(120000,()=>req.destroy(Error('R2 request timed out')));
    req.end(options.body);
  });
}
async function successful(send, method, key, query={}, body=Buffer.alloc(0), headers={}) {
  let result;
  for(let attempt=0;attempt<3;attempt++) {
    result=await send(method,key,query,body,headers);
    if(result.status>=200&&result.status<300 && !/<Error>/.test(result.text||'')) return result;
    if(![429,500,502,503,504].includes(result.status)) break;
    await new Promise(resolve=>setTimeout(resolve,500*2**attempt));
  }
  throw Error(`R2 ${method} failed (HTTP ${result.status}; ${xmlValue(result.text||'','Code')||'request rejected'})`);
}
export async function uploadFile(file, machineId, send, {partSize=16*1024*1024, progress=()=>{}}={}) {
  const before=await stat(file);
  if(!before.isFile()||!before.size) throw Error('Choose a nonempty regular file');
  if(before.size>5*1024**4) throw Error('File exceeds the R2 object limit');
  const extension=path.extname(file).slice(1).toLowerCase();
  const contentType=ASSET_TYPES[extension];
  if(!contentType) throw Error('Unsupported static file type; scripts and HTML must stay in the Draft');
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(file)) hash.update(chunk);
  const digest=hash.digest('hex'), key=`${sha(machineId)}/${digest}.${extension}`;
  const old=await send('HEAD',key,{},Buffer.alloc(0));
  if(old.status===200) {
    if(Number(old.headers['content-length'])!==before.size || old.headers['x-amz-meta-sha256']!==digest) throw Error('Existing object does not match file');
    return {url:`${ASSET_ORIGIN}/${key}`,key,sha256:digest,bytes:before.size,contentType,deduped:true};
  }
  if(old.status!==404) throw Error(`R2 object check failed (HTTP ${old.status})`);
  partSize=Math.max(partSize,Math.ceil(before.size/9999));
  const init=await successful(send,'POST',key,{uploads:''},Buffer.alloc(0),{'content-type':contentType,'x-amz-meta-sha256':digest});
  const uploadId=xmlValue(init.text,'UploadId');
  if(!uploadId) throw Error('R2 did not return a multipart upload ID');
  const fd=await open(file,'r'), uploadedHash=createHash('sha256'), parts=[];
  try {
    const buffer=Buffer.alloc(Math.min(partSize,before.size));
    let offset=0;
    while(offset<before.size) {
      const wanted=Math.min(buffer.length,before.size-offset);
      let filled=0;
      while(filled<wanted) {
        const {bytesRead}=await fd.read(buffer,filled,wanted-filled,offset+filled);
        if(!bytesRead) throw Error('File changed during upload');
        filled+=bytesRead;
      }
      const bytes=buffer.subarray(0,filled); uploadedHash.update(bytes);
      const number=parts.length+1;
      const response=await successful(send,'PUT',key,{partNumber:String(number),uploadId},bytes);
      if(!response.headers.etag) throw Error('R2 did not return the uploaded part ETag');
      parts.push({number,etag:response.headers.etag}); offset+=filled;
      progress({bytes:offset,total:before.size,part:number});
    }
    const after=await fd.stat();
    if(after.size!==before.size || after.mtimeMs!==before.mtimeMs || uploadedHash.digest('hex')!==digest) throw Error('File changed during upload');
    const xml='<CompleteMultipartUpload>'+parts.map(p=>`<Part><PartNumber>${p.number}</PartNumber><ETag>${xmlEscape(p.etag)}</ETag></Part>`).join('')+'</CompleteMultipartUpload>';
    await successful(send,'POST',key,{uploadId},Buffer.from(xml),{'content-type':'application/xml'});
  } catch(error) {
    const aborted=await send('DELETE',key,{uploadId},Buffer.alloc(0)).catch(()=>null);
    if(!aborted || aborted.status<200 || aborted.status>=300) throw Error(`${error.message}; multipart cleanup failed; retry cleanup with an administrator`);
    throw error;
  } finally { await fd.close(); }
  const verified=await successful(send,'HEAD',key);
  if(Number(verified.headers['content-length'])!==before.size || verified.headers['x-amz-meta-sha256']!==digest) throw Error('Uploaded object failed size/hash metadata verification');
  return {url:`${ASSET_ORIGIN}/${key}`,key,sha256:digest,bytes:before.size,contentType,deduped:false};
}
export async function loadCredentials(file) {
  const info=await stat(file);
  if(info.mode&0o077) throw Error('Draft asset credential file must have mode 0600');
  const c=JSON.parse(await readFile(file,'utf8'));
  if(c.accountId!==ASSET_ACCOUNT || c.bucket!==ASSET_BUCKET || !/^[a-f0-9]{32}$/.test(c.accessKeyId||'') || !/^[a-f0-9]{64}$/.test(c.secretAccessKey||'')) throw Error('Invalid credential file for the fixed Draft asset bucket');
  return c;
}
async function main() {
  const args=process.argv.slice(2);
  const value=flag=>{const i=args.indexOf(flag);return i<0?'':args[i+1]||'';};
  if(!value('--file')||args.some((a,i)=>i%2===0&&!['--file','--api','--credentials'].includes(a))) throw Error('Usage: node upload-asset.mjs --file clip.mp4 [--api https://eng.xyznot.com] [--credentials /private/path.json]');
  const credentials=await loadCredentials(value('--credentials')||process.env.TMAX_DRAFT_ASSET_CONFIG||path.join(os.homedir(),'.config/tmux-mobile/draft-assets.json'));
  const api=new URL(value('--api')||'https://eng.xyznot.com').origin;
  if(!api.startsWith('https://')) throw Error('Draft Host must use HTTPS');
  const config=JSON.parse(await readFile(process.env.TMUX_MOBILE_AGENT_CONFIG||path.join(os.homedir(),'.config/tmux-mobile/agent.json'),'utf8'));
  const entry=config.controllers?.[api==='https://eng.xyznot.com'?'https://eng.impo.ai':api];
  if(!entry?.token||!entry?.agentId) throw Error('This machine needs a Connector login for the selected Host');
  const response=await fetch(`${api}/agent/drafts?context=1`,{headers:{authorization:`Bearer ${entry.token}`,'x-agent-id':entry.agentId},redirect:'error',signal:AbortSignal.timeout(30000)});
  if(!response.ok) throw Error(`Could not identify this machine (HTTP ${response.status})`);
  const {machineId}=await response.json();
  if(typeof machineId!=='string'||!machineId.startsWith('m:')) throw Error('Host did not identify this machine');
  const result=await uploadFile(path.resolve(value('--file')),machineId,(...args)=>sendR2(credentials,...args),{progress:p=>process.stderr.write(`Uploaded ${p.bytes}/${p.total} bytes\n`)});
  console.log(JSON.stringify(result,null,2));
}
if(process.argv[1] && await realpath(process.argv[1]).catch(()=>null)===fileURLToPath(import.meta.url)) main().catch(error=>{console.error(error.message);process.exitCode=1;});

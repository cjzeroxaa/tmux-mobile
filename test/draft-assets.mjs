import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { uploadFile, signedRequest, loadCredentials } from '../public/skills/tmax-drafts/scripts/upload-asset.mjs';
import { ASSET_ACCOUNT, ASSET_BUCKET, ASSET_ORIGIN } from '../public/skills/tmax-drafts/scripts/asset-contract.mjs';
import { signDraftAssets, machineAssetPrefix, assetSigningKey } from '../lib/draft-assets.mjs';
import { validateDraftHtml } from '../lib/drafts.mjs';
import worker, { validToken, parseRange } from '../services/draft-assets/worker.mjs';
const machine='m:test-owner:machine1', now=Date.now(), secret='test-only-signing-secret';
const key=machineAssetPrefix(machine)+'a'.repeat(64)+'.mp4', url=ASSET_ORIGIN+'/'+key;
const html=body=>Buffer.from(`<html><head><title>Assets</title></head><body>${body}</body></html>`);
assert.doesNotThrow(()=>validateDraftHtml(html(`<video src="${url}" controls></video>`),{machineId:machine}));
assert.throws(()=>validateDraftHtml(html(`<video src="${url}" controls></video>`),{machineId:'m:other'}),/publishing machine/);
for(const bad of [`<script src="${url}"></script>`,`<video src="https://evil.test/a.mp4"></video>`,`<video src="data:video/mp4;base64,abc"></video>`,`<video src="${url}?token=old"></video>`]) assert.throws(()=>validateDraftHtml(html(bad),{machineId:machine}));
const signed=signDraftAssets(url,machine,secret,now), token=new URL(signed).searchParams.get('token');
assert.equal(await validToken('/'+key,token,assetSigningKey(secret),now),true);
assert.equal(await validToken('/'+key,token,assetSigningKey('wrong'),now),false);
assert.equal(await validToken('/'+key,token,assetSigningKey(secret),now+86401000),false);
assert.equal(await validToken('/'+key.replace('.mp4','.png'),token,assetSigningKey(secret),now),false);
assert.throws(()=>signDraftAssets(url,'m:other',secret),/Invalid Draft asset/);
assert.equal(signDraftAssets('no assets',machine,undefined),'no assets');
assert.throws(()=>signDraftAssets(url,machine,undefined),/unavailable/);
const bytes=Buffer.from('0123456789'), metadata={size:bytes.length,httpEtag:'"etag"',writeHttpMetadata:h=>h.set('content-type','video/mp4')};
let gets=0;
const env={READ_KEY:assetSigningKey(secret),ASSETS:{head:async()=>metadata,get:async(k,opts)=>{gets++;const r=opts?.range;return {body:r?bytes.subarray(r.offset,r.offset+r.length):bytes};}}};
assert.equal((await worker.fetch(new Request(url),env)).status,403);assert.equal(gets,0);
for(const [range,status,body] of [['bytes=2-5',206,'2345'],['bytes=-3',206,'789'],['bytes=7-',206,'789'],['bytes=999-',416,''],['bytes=1-2,5-6',416,'']]) {
  const response=await worker.fetch(new Request(signed,{headers:{range}}),env);
  assert.equal(response.status,status);assert.equal(await response.text(),body);
}
const full=await worker.fetch(new Request(signed),env);assert.equal(full.status,200);assert.equal(await full.text(),'0123456789');
const head=await worker.fetch(new Request(signed,{method:'HEAD'}),env);assert.equal(head.headers.get('content-length'),'10');assert.equal(await head.text(),'');
const preflight=await worker.fetch(new Request(signed,{method:'OPTIONS'}),env);assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),'*');
assert.equal(parseRange('bytes=-0',10),false);
const temp=await mkdtemp(path.join(os.tmpdir(),'draft-assets-'));
try {
  const file=path.join(temp,'movie.mp4'), source=Buffer.alloc(2*1024*1024+123,0x5a);
  await writeFile(file,source);
  const digest=createHash('sha256').update(source).digest('hex');
  let complete=false, maxBody=0, uploaded=0, aborted=false;const parts=[];
  const send=async(method,k,query,body)=>{
    assert.equal(k,machineAssetPrefix(machine)+digest+'.mp4');
    if(method==='HEAD') return complete?{status:200,headers:{'content-length':String(source.length),'x-amz-meta-sha256':digest}}:{status:404};
    if(method==='POST'&&'uploads' in query) return {status:200,text:'<UploadId>upload-123</UploadId>'};
    if(method==='PUT') {maxBody=Math.max(maxBody,body.length);uploaded+=body.length;parts.push(Buffer.from(body));return {status:200,headers:{etag:'"part"'}};}
    if(method==='POST') {assert.match(body.toString(),/CompleteMultipartUpload/);complete=true;return {status:200,text:'<CompleteMultipartUploadResult/>'};}
    if(method==='DELETE'){aborted=true;return {status:204};}
    throw Error('unexpected request');
  };
  const result=await uploadFile(file,machine,send,{partSize:64*1024});
  assert.equal(result.bytes,source.length);assert.equal(result.sha256,digest);assert.equal(maxBody,64*1024);assert.equal(uploaded,source.length);assert.deepEqual(Buffer.concat(parts),source);assert.equal(aborted,false);
  assert.equal((await uploadFile(file,machine,send)).deduped,true);
  complete=false;
  await assert.rejects(uploadFile(file,machine,async(...args)=>args[0]==='PUT'?{status:403,text:'<Error><Code>AccessDenied</Code></Error>'}:send(...args),{partSize:64*1024}),/AccessDenied/);
  assert.equal(aborted,true);
  const credentials={accountId:ASSET_ACCOUNT,bucket:ASSET_BUCKET,accessKeyId:'a'.repeat(32),secretAccessKey:'b'.repeat(64)};
  const cfile=path.join(temp,'credentials.json');await writeFile(cfile,JSON.stringify(credentials),{mode:0o600});
  assert.deepEqual(await loadCredentials(cfile),credentials);
  await chmod(cfile,0o644);await assert.rejects(loadCredentials(cfile),/0600/);
  const signedRequestResult=signedRequest(credentials,'PUT',key,{},Buffer.from('abc'),{},new Date('2026-10-21T12:00:00Z'));
  assert.equal(signedRequestResult.hostname,ASSET_ACCOUNT+'.r2.cloudflarestorage.com');
  assert.equal(signedRequestResult.headers['x-amz-content-sha256'],createHash('sha256').update('abc').digest('hex'));
  assert.match(signedRequestResult.headers.authorization,/20261021\/auto\/s3\/aws4_request/);
  assert.ok(!JSON.stringify(result).includes(credentials.secretAccessKey));
} finally {await rm(temp,{recursive:true,force:true});}
console.log('Draft assets: machine binding, private read signatures, expiry, Range/HEAD/CORS, multipart bytes/dedup/abort and private credential loading passed');

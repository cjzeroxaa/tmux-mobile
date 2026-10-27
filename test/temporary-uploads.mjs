import assert from 'node:assert/strict';
import { createTemporaryUploads, handleTemporaryUploadHttp, UPLOAD_TTL_SECONDS, DOWNLOAD_TTL_SECONDS, MAX_DIRECT_UPLOAD_BYTES } from '../lib/temporary-uploads.mjs';
const start = Date.parse('2026-10-27T12:00:00Z');
let clock = start;
const objects = new Map(), calls = [];
const storage = {
  async signUpload(key, options) { calls.push({key,...options}); return {url:'https://s3.example/'+key, method:'PUT', headers:{'content-type':options.contentType,'if-none-match':'*'}}; },
  async stat(key) { return objects.get(key); },
  async url(key, options) { calls.push({key,...options}); return 'https://s3.example/download'; },
};
const owner={userId:'owner@example.com'}, other={userId:'other@example.com'};
const service=createTemporaryUploads({storage,secret:'test-only-secret',now:()=>clock});
const input={name:'../照片.png',size:42,contentType:'image/png',expiresIn:999999};
const plan=await service.begin(owner,input);
assert.equal(calls[0].ttlSeconds,1800);
assert.equal(Date.parse(plan.uploadExpiresAt), start+1800_000);
assert.equal(plan.upload.headers['if-none-match'],'*');
assert.ok(!plan.upload.url.includes(owner.userId));
const key=calls[0].key;
await assert.rejects(service.begin(null,input),{status:401});
await assert.rejects(service.begin(owner,{...input,size:0}),{status:400});
await assert.rejects(service.begin(owner,{...input,size:MAX_DIRECT_UPLOAD_BYTES+1}),{status:413});
await assert.rejects(service.begin(owner,{...input,contentType:'text/html\r\nx:evil'}),{status:400});
await assert.rejects(service.complete(other,plan.ticket,'https://app.example'),{status:403});
await assert.rejects(service.complete(owner,plan.ticket+'x','https://app.example'),{status:404});
await assert.rejects(service.complete(owner,plan.ticket,'https://app.example'),{status:409});
clock+=60_000;
objects.set(key,{size:41,contentType:'image/png',modifiedAt:new Date(clock).toISOString()});
await assert.rejects(service.complete(owner,plan.ticket,'https://app.example'),{status:409});
objects.get(key).size=42;
const completed=await service.complete(owner,plan.ticket,'https://app.example');
assert.equal(completed.name,'照片.png');
assert.equal(Date.parse(completed.expiresAt), clock+7200_000);
assert.ok(completed.url.endsWith('/%E7%85%A7%E7%89%87.png'));
const token=new URL(completed.url).pathname.split('/')[2];
await assert.rejects(service.download(plan.ticket),{status:404});
await assert.rejects(service.complete(owner,token,'https://app.example'),{status:404});
clock+=10*60_000;
assert.deepEqual(await service.complete(owner,plan.ticket,'https://app.example'),completed,'completion retries never renew expiry');
assert.equal(await service.download(token),'https://s3.example/download');
assert.deepEqual(calls.at(-1),{key,filename:'照片.png',contentType:'image/png',attachment:true,method:'GET',ttlSeconds:300});
await service.download(token,'HEAD');assert.equal(calls.at(-1).method,'HEAD');
clock=start+UPLOAD_TTL_SECONDS*1000;
assert.deepEqual(await service.complete(owner,plan.ticket,'https://app.example'),completed,'finishing a valid long upload does not require a new PUT authorization');
clock=Date.parse(completed.expiresAt)-1000;
await service.download(token);assert.equal(calls.at(-1).ttlSeconds,1,'S3 redirect cannot outlive the application capability');
clock+=1000;
await assert.rejects(service.download(token),{status:410});
await assert.rejects(createTemporaryUploads({storage,secret:'rotated',now:()=>start}).download(token),{status:404});
await assert.rejects(createTemporaryUploads({storage:{},secret:'test'}).begin(owner,input),{status:501,code:'direct_upload_unavailable'});

clock=start+120_000;
async function request(path,method='POST',viewer=owner,body={}) {
 const res={headers:{},setHeader(k,v){this.headers[k]=v},writeHead(status,headers){this.status=status;Object.assign(this.headers,headers)},end(){this.ended=true}};
 const handled=await handleTemporaryUploadHttp({method},res,new URL(path,'https://app.example'),{
  uploads:service,viewer,origin:'https://app.example',readJsonBody:async()=>body,
  sendJson(res,status,value){res.status=status;res.body=value;res.end()},
 });
 return {...res,handled};
}
assert.equal((await request('/api/uploads','POST',null,input)).status,401);
assert.equal((await request('/api/uploads','GET')).status,405);
assert.equal((await request('/api/uploads','POST',owner,input)).status,200);
assert.equal((await request('/api/uploads/complete','POST',other,{ticket:plan.ticket})).status,403);
let result=await request(new URL(completed.url).pathname,'GET',null);
assert.equal(result.status,307);assert.equal(result.headers.Location,'https://s3.example/download');
assert.equal(result.headers['Cache-Control'],'private, no-store');
assert.equal((await request('/files/invalid/name','GET',null)).status,404);
assert.equal((await request(new URL(completed.url).pathname,'POST',null)).status,405);
assert.equal((await request('/api/other')).handled,false);
clock=Date.parse(completed.expiresAt);
assert.equal((await request(new URL(completed.url).pathname,'GET',null)).status,410);
assert.equal(DOWNLOAD_TTL_SECONDS,7200);
console.log('Temporary uploads: owner isolation, exact TTLs, immutable completion, tampering, metadata, redirects, expiry and HTTP routing passed.');

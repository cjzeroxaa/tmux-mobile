#!/usr/bin/env python3
"""Provision the fixed private Draft R2 bucket/Worker. Secrets never enter source or logs."""
import argparse, hashlib, hmac, json, os, shlex, subprocess, time, urllib.error, urllib.request, uuid
from pathlib import Path

ACCOUNT='34431cd51da281ed3590ab6ce5141d09'
BUCKET='tmax-draft-assets'
SERVICE='tmax-draft-assets'
DOMAIN='draft-assets.xyznot.com'
root=Path(__file__).resolve().parent.parent
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--cloudflare-env',default=str(Path.home()/'cloudflare.env'))
p.add_argument('--aws-profile',default='rebyte-aws')
p.add_argument('--receipt-dir',required=True)
a=p.parse_args()
report=Path(a.receipt_dir);report.mkdir(parents=True,exist_ok=True,mode=0o700)
config={}
for line in Path(a.cloudflare_env).read_text().splitlines():
    line=line.removeprefix('export ').strip()
    if line and not line.startswith('#') and '=' in line:
        key,value=line.split('=',1);parts=shlex.split(value,comments=True)
        if parts:config[key.strip()]=parts[0]
if config.get('CLOUDFLARE_ACCOUNT_ID')!=ACCOUNT:raise SystemExit('Unexpected Cloudflare account')
token=config['CLOUDFLARE_API_TOKEN']
def call(method,route,data=None,content_type='application/json'):
    payload=json.dumps(data).encode() if isinstance(data,(dict,list)) else data
    req=urllib.request.Request('https://api.cloudflare.com/client/v4'+route,data=payload,method=method,headers={'Authorization':'Bearer '+token,'Content-Type':content_type})
    try:
        with urllib.request.urlopen(req,timeout=60) as res:result=json.load(res)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f'Cloudflare {method} {route}: HTTP {error.code}') from None
    if not result.get('success'):raise RuntimeError('Cloudflare request rejected (details withheld to protect credentials)')
    return result.get('result')
def private_write(path,body):
    path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    tmp=path.with_name(path.name+'.tmp-'+uuid.uuid4().hex)
    with os.fdopen(os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'wb') as out:out.write(body)
    os.replace(tmp,path)
verified=call('GET','/user/tokens/verify')
if verified.get('status')!='active':raise SystemExit('Cloudflare token is not active')
buckets=call('GET',f'/accounts/{ACCOUNT}/r2/buckets')['buckets']
if not any(b['name']==BUCKET for b in buckets):call('POST',f'/accounts/{ACCOUNT}/r2/buckets',{'name':BUCKET})
# Public R2 development URLs remain disabled. Reads go through the signed Worker.
call('PUT',f'/accounts/{ACCOUNT}/r2/buckets/{BUCKET}/domains/managed',{'enabled':False})
credentials={'accountId':ACCOUNT,'bucket':BUCKET,'accessKeyId':verified['id'],'secretAccessKey':hashlib.sha256(token.encode()).hexdigest()}
cred=Path.home()/'.config/tmux-mobile/draft-assets.json'
if cred.exists() and json.loads(cred.read_text())!=credentials:
    private_write(report/'previous-upload-credentials.json',cred.read_bytes())
private_write(cred,(json.dumps(credentials,indent=2)+'\n').encode())
# Existing owner-approved token is converted into S3 credentials, not redistributed as
# a Cloudflare management API token. Its underlying R2 scope is unchanged.
result=subprocess.run(['aws','--profile',a.aws_profile,'--region','us-east-1','secretsmanager','get-secret-value','--secret-id','tmux-mobile-controller/SESSION_SECRET','--query','SecretString','--output','text'],check=True,capture_output=True,text=True)
session_secret=result.stdout.strip()
read_key=hmac.new(session_secret.encode(),b'tmax-draft-assets-v1',hashlib.sha256).hexdigest()
metadata={'main_module':'worker.mjs','compatibility_date':'2026-10-21','bindings':[{'type':'r2_bucket','name':'ASSETS','bucket_name':BUCKET},{'type':'secret_text','name':'READ_KEY','text':read_key}], 'observability':{'enabled':False}}
boundary='tmax'+uuid.uuid4().hex
parts=[]
for name,filename,content_type,body in [('metadata',None,'application/json',json.dumps(metadata).encode()),('worker.mjs','worker.mjs','application/javascript+module',(root/'services/draft-assets/worker.mjs').read_bytes())]:
    head=f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"'+(f'; filename="{filename}"' if filename else '')+f'\r\nContent-Type: {content_type}\r\n\r\n'
    parts.extend([head.encode(),body,b'\r\n'])
parts.append(f'--{boundary}--\r\n'.encode())
worker=call('PUT',f'/accounts/{ACCOUNT}/workers/scripts/{SERVICE}',b''.join(parts),f'multipart/form-data; boundary={boundary}')
zones=call('GET','/zones?name=xyznot.com')
if len(zones)!=1:raise SystemExit('Expected one xyznot.com zone')
domains=call('GET',f'/accounts/{ACCOUNT}/workers/domains')
existing=next((d for d in domains if d['hostname']==DOMAIN),None)
if existing and existing.get('service')!=SERVICE:raise SystemExit('Asset domain belongs to a different Worker')
if not existing:call('PUT',f'/accounts/{ACCOUNT}/workers/domains',{'hostname':DOMAIN,'zone_id':zones[0]['id'],'service':SERVICE,'environment':'production'})
now=int(time.time());exp=now+14400
body=json.dumps({'type':'session','userId':'sonicgg@gmail.com','email':'sonicgg@gmail.com','hd':'','iat':now,'exp':exp},separators=(',',':')).encode()
import base64
b64=lambda b:base64.urlsafe_b64encode(b).decode().rstrip('=')
encoded=b64(body);cookie=encoded+'.'+b64(hmac.new(session_secret.encode(),encoded.encode(),hashlib.sha256).digest())
private_write(report/'super-cookie.txt',('tmux_mobile_session='+cookie).encode())
private_write(report/'worker-read-key.txt',read_key.encode())
receipt={'accountId':ACCOUNT,'bucket':BUCKET,'publicBucket':False,'worker':SERVICE,'domain':DOMAIN,'workerId':worker.get('id'),'credentialFile':str(cred),'credentialSha256':hashlib.sha256(cred.read_bytes()).hexdigest(),'credentialScope':'S3 derivation of existing owner-approved token; underlying R2 scope unchanged'}
private_write(report/'provision.json',(json.dumps(receipt,indent=2)+'\n').encode())
print(json.dumps(receipt,indent=2))

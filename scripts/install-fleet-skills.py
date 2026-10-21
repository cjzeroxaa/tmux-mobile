#!/usr/bin/env python3
"""Install checked-in T-Max skills through dedicated Connector shell sessions.

Requires an existing super-admin Cookie header in a mode-0600 file. Never sends
commands to existing coding-agent sessions. Writes one verified receipt per host.
"""
import argparse
import re
import base64
import hashlib
import json
import os
from pathlib import Path
import shlex
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--cookie-file', required=True)
p.add_argument('--api', default='https://eng.xyznot.com')
p.add_argument('--receipts', required=True)
p.add_argument('--machine', help='Optional exact hostname to install first')
p.add_argument('--skill', choices=['tmax-drafts', 'tmax-start-agent', 'tmax-config-agent', 'tmax-assign-task'], default='tmax-drafts')
p.add_argument('--local-installer', action='store_true', help='Copy the checked-out installer through the Connector instead of downloading it')
p.add_argument('--asset-credentials', help='Private 0600 R2 credential JSON to provision after installing tmax-drafts')
p.add_argument('--asset-probe-key', help='Existing object key for credential verification')
a = p.parse_args()
cookie_path = Path(a.cookie_file)
if cookie_path.stat().st_mode & 0o077:
    raise SystemExit('Cookie file must be mode 0600')
cookie = cookie_path.read_text().strip()
out = Path(a.receipts)
out.mkdir(parents=True, exist_ok=True)
repository = Path(__file__).resolve().parent.parent
installer_hash = hashlib.sha256((repository / 'public/skills/install.mjs').read_bytes()).hexdigest()
manifest = json.loads((repository / 'public/skills' / a.skill / 'manifest.json').read_text())
expected = hashlib.sha256(json.dumps(manifest['files'], separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
asset_credentials = None
if a.asset_credentials:
    credential_file = Path(a.asset_credentials)
    if a.skill != 'tmax-drafts' or not a.asset_probe_key or credential_file.stat().st_mode & 0o077:
        raise SystemExit('Asset provisioning requires tmax-drafts, a probe key, and a private 0600 credential file')
    asset_credentials = credential_file.read_bytes()
    audit_inventory = {
        'skills': {d.name: json.loads((d / 'manifest.json').read_text())['files']
                   for d in (repository / 'public/skills').iterdir() if (d / 'manifest.json').is_file()},
        'globalInstructionSha256': hashlib.sha256((Path.home() / '.config/agent-instructions/AGENTS.md').read_bytes()).hexdigest(),
    }

def upload_private(machine, pane, name, body):
    route = '/api/upload?' + urllib.parse.urlencode({'paneId': pane, 'name': name})
    request = urllib.request.Request(a.api.rstrip('/') + route, data=body, method='POST',
        headers={'Cookie': cookie, 'Content-Type': 'application/octet-stream', 'x-machine-id': machine['id'], 'x-mux': 'tmux'})
    with urllib.request.urlopen(request, timeout=45) as response:
        return json.load(response)['path']

def call(route, data=None, machine=None, method=None):
    if route == '/api/send' and data and data.get('enter'):
        result = call(route, {**data, 'enter': False}, machine, method)
        time.sleep(1)
        call('/api/key', {'paneId': data['paneId'], 'key': 'Enter'}, machine)
        return result
    headers = {'Cookie': cookie, 'Content-Type': 'application/json'}
    if machine:
        headers['x-machine-id'] = machine['id']
        headers['x-mux'] = 'tmux'
    request = urllib.request.Request(a.api.rstrip('/') + route, headers=headers,
        data=json.dumps(data).encode() if data is not None else None, method=method)
    with urllib.request.urlopen(request, timeout=45) as response:
        return json.load(response)

machines = call('/api/command-center')['machines']
if a.machine:
    machines = [m for m in machines if m['hostname'] == a.machine]
if not machines:
    raise SystemExit('No matching machines are visible; retry after Connectors reconnect')
results = []
for machine in machines:
    row = {k: machine.get(k) for k in ['id', 'hostname', 'ownerEmail', 'online']}
    window = None
    private_paths = []
    try:
        if not machine.get('online'):
            row['status'] = 'offline'
            continue
        nonce = uuid.uuid4().hex
        session = call('/api/sessions', {'name': 'tmax-skill-install-' + nonce[:12]}, machine)
        windows = call('/api/windows?' + urllib.parse.urlencode({'sessionId': session['id']}), machine=machine)
        if len(windows) != 1: raise RuntimeError('Unexpected temporary session layout')
        window = windows[0]
        panes = call('/api/panes?' + urllib.parse.urlencode({'windowId': window['id']}), machine=machine)
        if len(panes) != 1 or panes[0]['command'] not in ['bash', 'zsh', 'sh', 'fish', 'dash']:
            raise RuntimeError('Temporary pane is not a plain shell')
        pane = panes[0]['id']
        # Inspect shell startup, decline optional oh-my-zsh updates, then probe.
        time.sleep(2)
        screen = call('/api/capture?' + urllib.parse.urlencode({'paneId': pane, 'lines': 20}), machine=machine).get('text', '')
        if 'Would you like to update?' in screen:
            call('/api/send', {'paneId': pane, 'text': 'n', 'enter': True}, machine)
            time.sleep(2)
        marker = 'TMAX_READY_' + nonce[:12]
        ready = False
        for attempt in range(3):
            call('/api/send', {'paneId': pane, 'text': "printf '\\n%s\\n' " + shlex.quote(marker), 'enter': True}, machine)
            for check in range(4):
                time.sleep(1)
                screen = call('/api/capture?' + urllib.parse.urlencode({'paneId': pane, 'lines': 30}), machine=machine).get('text', '')
                clean = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', screen)
                if marker in [line.strip() for line in clean.splitlines()]:
                    ready = True
                    break
            if ready: break
        if not ready: raise RuntimeError('Temporary shell did not become ready: '+screen[-1000:])
        prefix = '/tmp/tmax-skills-' + nonce
        script, receipt, log = prefix + '.mjs', prefix + '.json', prefix + '.log'
        node = shlex.quote(machine.get('nodePath') or 'node')
        download = 'curl -fsSL ' + shlex.quote(a.api.rstrip('/') + '/skills/install.mjs') + ' -o ' + shlex.quote(script)
        if a.local_installer:
            payload = base64.b64encode((repository / 'public/skills/install.mjs').read_bytes()).decode()
            writer = "require('fs').writeFileSync(process.argv[1],Buffer.from(process.argv[2],'base64'))"
            download = node + ' -e ' + shlex.quote(writer) + ' ' + shlex.quote(script) + ' ' + shlex.quote(payload)
        check = "const f=require('fs'),c=require('crypto');if(c.createHash('sha256').update(f.readFileSync(process.argv[1])).digest('hex')!==process.argv[2])process.exit(1)"
        shell = '\n'.join([
            'set -eu',
            'umask 077',
            download,
            node + ' -e ' + shlex.quote(check) + ' ' + shlex.quote(script) + ' ' + installer_hash,
            node + ' ' + shlex.quote(script) + ' --skill ' + shlex.quote(a.skill) + ' --api ' + shlex.quote(a.api) + ' > ' + shlex.quote(log) + ' 2>&1',
            node + ' ' + shlex.quote(script) + ' --skill ' + shlex.quote(a.skill) + ' --api ' + shlex.quote(a.api) + ' --verify > ' + shlex.quote(receipt) + ' 2>> ' + shlex.quote(log),
            'rm -f ' + shlex.quote(script),
        ])
        call('/api/send', {'paneId': pane, 'text': 'sh -c ' + shlex.quote(shell), 'enter': True}, machine)
        deadline = time.monotonic() + 180
        verified = None
        while time.monotonic() < deadline:
            time.sleep(3)
            try:
                data = call('/api/file?' + urllib.parse.urlencode({'paneId': pane, 'path': receipt}), machine=machine)
                verified = json.loads(base64.b64decode(data['base64']))
                break
            except (urllib.error.HTTPError, json.JSONDecodeError):
                pass
        if not verified:
            details = call('/api/capture?' + urllib.parse.urlencode({'paneId': pane, 'lines': 60}), machine=machine)
            raise RuntimeError('Install did not produce a receipt: ' + details.get('text', '')[-1500:])
        if verified['sha256'] != expected or len(verified['installations']) != 3 or any(x['status'] != 'verified' for x in verified['installations']):
            raise RuntimeError('Receipt does not match repository Skill')
        row.update(status='verified', receipt=verified)
        if asset_credentials:
            candidate = upload_private(machine, pane, 'tmax-draft-credential-' + nonce + '.json', asset_credentials)
            private_paths.append(candidate)
            helper = upload_private(machine, pane, 'tmax-draft-provision-' + nonce + '.mjs', (repository / 'scripts/provision-machine-draft-assets.mjs').read_bytes())
            private_paths.append(helper)
            inventory = upload_private(machine, pane, 'tmax-draft-inventory-' + nonce + '.json', json.dumps(audit_inventory).encode())
            private_paths.append(inventory)
            asset_receipt = prefix + '-assets.json'
            private_paths.extend([asset_receipt, asset_receipt + '.txt'])
            command = ' '.join([node, shlex.quote(helper), shlex.quote(candidate), shlex.quote(a.asset_probe_key), shlex.quote(asset_receipt), shlex.quote(inventory)])
            call('/api/send', {'paneId': pane, 'text': command, 'enter': True}, machine)
            deadline = time.monotonic() + 180
            asset_result = None
            while time.monotonic() < deadline:
                time.sleep(3)
                try:
                    data = call('/api/file?' + urllib.parse.urlencode({'paneId': pane, 'path': asset_receipt}), machine=machine)
                    asset_result = json.loads(base64.b64decode(data['base64']))
                    break
                except (urllib.error.HTTPError, json.JSONDecodeError):
                    pass
            if not asset_result:
                raise RuntimeError('Draft credential provisioning did not produce a receipt')
            row['assets'] = asset_result
            if asset_result['credentialMode'] != 0o600 or not asset_result.get('upload'):
                raise RuntimeError('Draft credential mode/upload verification failed')
            if not all(item['verified'] for item in asset_result['skills']):
                raise RuntimeError('One or more installed Skills differ from source')
            row['globalInstructionsStatus'] = ('verified unchanged' if all(item['verified'] for item in asset_result['globalInstructions'])
                                                else 'mismatch; unchanged by this Skill rollout')
        call('/api/send', {'paneId': pane, 'text': 'rm -f ' + shlex.quote(receipt) + ' ' + shlex.quote(log), 'enter': True}, machine)
        time.sleep(1)
    except Exception as error:
        row.update(status='failed', error=str(error))
    finally:
        if window:
            try:
                if private_paths:
                    call('/api/send', {'paneId': pane, 'text': 'rm -f ' + ' '.join(shlex.quote(x) for x in private_paths), 'enter': True}, machine)
                    time.sleep(1)
                call('/api/windows', {'windowId': window['id']}, machine, 'DELETE')
            except Exception as error: row['cleanupError'] = str(error)
        results.append(row)
        (out / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
        print(json.dumps(row), flush=True)
if any(x['status'] != 'verified' or x.get('cleanupError') for x in results):
    raise SystemExit(1)

#!/usr/bin/env python3
"""Install checked-in T-Max skills through dedicated Connector shell sessions.

Requires an existing super-admin Cookie header in a mode-0600 file. Never sends
commands to existing coding-agent sessions. Writes one verified receipt per host.
"""
import argparse
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
a = p.parse_args()
cookie_path = Path(a.cookie_file)
if cookie_path.stat().st_mode & 0o077:
    raise SystemExit('Cookie file must be mode 0600')
cookie = cookie_path.read_text().strip()
out = Path(a.receipts)
out.mkdir(parents=True, exist_ok=True)
repository = Path(__file__).resolve().parent.parent
installer_hash = hashlib.sha256((repository / 'public/skills/install.mjs').read_bytes()).hexdigest()
manifest = json.loads((repository / 'public/skills/tmax-drafts/manifest.json').read_text())
expected = hashlib.sha256(json.dumps(manifest['files'], separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()

def call(route, data=None, machine=None, method=None):
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
    if not machines: raise SystemExit('Machine not found')
results = []
for machine in machines:
    row = {k: machine.get(k) for k in ['id', 'hostname', 'ownerEmail', 'online']}
    window = None
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
        prefix = '/tmp/tmax-skills-' + nonce
        script, receipt, log = prefix + '.mjs', prefix + '.json', prefix + '.log'
        node = shlex.quote(machine.get('nodePath') or 'node')
        check = "const f=require('fs'),c=require('crypto');if(c.createHash('sha256').update(f.readFileSync(process.argv[1])).digest('hex')!==process.argv[2])process.exit(1)"
        shell = '\n'.join([
            'set -eu',
            'umask 077',
            'curl -fsSL ' + shlex.quote(a.api.rstrip('/') + '/skills/install.mjs') + ' -o ' + shlex.quote(script),
            node + ' -e ' + shlex.quote(check) + ' ' + shlex.quote(script) + ' ' + installer_hash,
            node + ' ' + shlex.quote(script) + ' --api ' + shlex.quote(a.api) + ' > ' + shlex.quote(log) + ' 2>&1',
            node + ' ' + shlex.quote(script) + ' --api ' + shlex.quote(a.api) + ' --verify > ' + shlex.quote(receipt) + ' 2>> ' + shlex.quote(log),
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
        call('/api/send', {'paneId': pane, 'text': 'rm -f ' + shlex.quote(receipt) + ' ' + shlex.quote(log), 'enter': True}, machine)
        time.sleep(1)
    except Exception as error:
        row.update(status='failed', error=str(error))
    finally:
        if window:
            try: call('/api/windows', {'windowId': window['id']}, machine, 'DELETE')
            except Exception as error: row['cleanupError'] = str(error)
        results.append(row)
        (out / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
        print(json.dumps(row), flush=True)
if any(x['status'] != 'verified' or x.get('cleanupError') for x in results):
    raise SystemExit(1)

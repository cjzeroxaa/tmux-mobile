#!/usr/bin/env python3
"""Create a named T-Max shell. The calling agent must inspect and finish startup."""
import argparse
import json
import os
from pathlib import Path
import pwd
import shlex
import subprocess


def create(agent, name, cwd, window_name=None):
    window_name = window_name or name
    for label, value in [('session name', name), ('window name', window_name)]:
        if not value or value.startswith('-') or any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError('Invalid ' + label)
    if ':' in name or '.' in name:
        raise ValueError('Session names cannot contain colon or dot; ask for another name')
    directory = Path(cwd).expanduser().resolve(strict=True)
    if not directory.is_dir():
        raise ValueError('Working directory is not a directory')
    shell = pwd.getpwuid(os.getuid()).pw_shell or os.environ.get('SHELL', '/bin/sh')
    if not Path(shell).is_file():
        raise ValueError('Login shell does not exist: ' + shell)

    def tmux(*args):
        return subprocess.check_output(['tmux', *args], text=True, timeout=15).strip()

    # new-session itself rejects duplicate names atomically. No -A, -L or -S:
    # never attach to someone else's session or create an invisible server.
    result = tmux('new-session', '-d', '-s', name, '-n', window_name,
                  '-c', str(directory), '-x', '140', '-y', '40', '-P',
                  '-F', '#{session_id}\t#{window_id}\t#{pane_id}',
                  shlex.quote(shell) + ' -il')
    session, window, pane = result.split('\t')
    receipt = {'agent': agent, 'sessionId': session, 'windowId': window,
               'paneId': pane, 'sessionName': name, 'windowName': window_name,
               'cwd': str(directory), 'ready': False,
               'launchCommand': 'cd -- ' + shlex.quote(str(directory)) + ' && ' + agent}
    # Print IDs first so even a subsequent configuration error is recoverable.
    print(json.dumps(receipt, ensure_ascii=False), flush=True)
    tmux('set-option', '-w', '-t', window, 'automatic-rename', 'off')
    tmux('set-option', '-w', '-t', window, 'allow-rename', 'off')
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--agent', choices=['claude', 'codex'], required=True)
    parser.add_argument('--name', required=True)
    parser.add_argument('--window-name')
    parser.add_argument('--cwd', required=True)
    args = parser.parse_args()
    create(args.agent, args.name, args.cwd, args.window_name)

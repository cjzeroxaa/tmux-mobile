"""Verify visible-session launch receipts without starting a real coding agent."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import shlex
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

source = Path(__file__).resolve().parent.parent / 'public/skills/tmax-start-agent/scripts/create-session.py'
spec = importlib.util.spec_from_file_location('tmax_start', source)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class StartAgentTests(unittest.TestCase):
    def test_all_runtimes_use_one_visible_window_and_bare_interactive_command(self):
        with tempfile.TemporaryDirectory(prefix="tmax work ' ") as directory:
            for agent in ['codex', 'claude', 'pi']:
                with self.subTest(agent=agent):
                    calls = []

                    def tmux(args, **kwargs):
                        calls.append(args)
                        return '$7\t@8\t%9\n' if args[1] == 'new-session' else ''

                    output = io.StringIO()
                    with patch.object(helper.subprocess, 'check_output', side_effect=tmux), \
                         patch.object(helper.pwd, 'getpwuid', return_value=SimpleNamespace(pw_shell='/bin/sh')), \
                         contextlib.redirect_stdout(output):
                        result = helper.create(agent, 'project-api', directory)
                    self.assertEqual(json.loads(output.getvalue()), result)
                    self.assertFalse(result['ready'])
                    self.assertEqual((result['sessionId'], result['windowId'], result['paneId']), ('$7', '@8', '%9'))
                    self.assertEqual(result['sessionName'], result['windowName'])
                    self.assertEqual(shlex.split(result['launchCommand']), ['cd', '--', str(Path(directory).resolve()), '&&', agent])
                    self.assertEqual(sum(c[1] == 'new-session' for c in calls), 1)
                    self.assertEqual(calls[0][-1], '/bin/sh -il')
                    self.assertFalse(any(flag in c for c in calls for flag in ['-L', '-S', '-A', 'send-keys']))

    def test_rejects_unsupported_agent_before_creating_any_session(self):
        with patch.object(helper.subprocess, 'check_output') as tmux:
            with self.assertRaisesRegex(ValueError, 'Unsupported agent'):
                helper.create('pi; bad-command', 'project-api', '.')
            tmux.assert_not_called()


if __name__ == '__main__':
    unittest.main()

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import service


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='caa-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        shutil.copy(service.__file__, self.root / 'service.py')
        (self.root / 'enabled').touch()
        self.process = self.start_service()

    @staticmethod
    def stop_process(process):
        process.terminate()
        process.communicate(timeout=5)

    def start_service(self):
        process = subprocess.Popen([sys.executable, str(self.root / 'service.py')],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(self.stop_process, process)
        self.assertIn('等待 Codex 审批事件', process.stdout.readline())
        return process

    def request(self, session_id='test-thread', event='PermissionRequest'):
        env = dict(os.environ)
        for name in ('TMUX', 'TMUX_PANE'):
            env.pop(name, None)
        result = subprocess.run([sys.executable, str(self.root / 'service.py'), 'hook'],
                                input=json.dumps({'hook_event_name': event, 'session_id': session_id}),
                                env=env, text=True, capture_output=True, check=True, timeout=5)
        return json.loads(result.stdout)

    def test_multiple_sessions_and_events(self):
        for session in ('main', 'side', 'background'):
            self.assertEqual(self.request(session), service.ALLOW)
        self.assertEqual(self.request(event='Stop'), {})

    def test_offline_disabled_restart_and_idle(self):
        self.assertEqual(self.request(), service.ALLOW)
        stat = Path(f'/proc/{self.process.pid}/stat')
        def cpu_ticks():
            fields = stat.read_text().split()
            return int(fields[13]) + int(fields[14])
        before = cpu_ticks()
        time.sleep(0.3)
        self.assertEqual(cpu_ticks(), before)
        (self.root / 'enabled').unlink()
        self.assertEqual(self.request(), {})
        (self.root / 'enabled').touch()
        self.assertEqual(self.request(), service.ALLOW)
        self.stop_process(self.process)
        self.assertEqual(self.request(), {})
        self.start_service()
        self.assertEqual(self.request(), service.ALLOW)


class ConfigTests(unittest.TestCase):
    def test_install_preserves_hooks_and_is_repeatable(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            original = {'description': 'existing', 'hooks': {
                'Stop': [{'hooks': [{'type': 'command', 'command': 'echo done'}]}],
                'PermissionRequest': [{'matcher': 'Bash', 'hooks': [
                    {'type': 'command', 'command': 'echo policy'}]}]}}
            (root / 'hooks.json').write_text(json.dumps(original))
            with patch.object(service, 'ROOT', root):
                path, command = service.configure_hook(root)
                service.configure_hook(root)
            config = json.loads(path.read_text())
            self.assertEqual(config['description'], 'existing')
            self.assertEqual(config['hooks']['Stop'], original['hooks']['Stop'])
            groups = config['hooks']['PermissionRequest']
            self.assertEqual(groups[0], original['hooks']['PermissionRequest'][0])
            self.assertEqual(len(groups), 2)
            self.assertEqual(groups[1]['hooks'][0]['command'], command)


if __name__ == '__main__':
    unittest.main()

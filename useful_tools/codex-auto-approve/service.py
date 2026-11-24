#!/usr/bin/env python3
import json
import os
from pathlib import Path
import shlex
import socket
import subprocess
import sys


ROOT = Path(__file__).resolve().parent
SOCKET = ROOT / '.runtime' / 'approver.sock'
ALLOW = {'hookSpecificOutput': {
    'hookEventName': 'PermissionRequest', 'decision': {'behavior': 'allow'}}}


def serve():
    SOCKET.parent.mkdir(mode=0o700, exist_ok=True)
    SOCKET.unlink(missing_ok=True)
    with socket.socket(socket.AF_UNIX) as server:
        server.bind(str(SOCKET))
        os.chmod(SOCKET, 0o600)
        server.listen()
        print('确认助手：等待 Codex 审批事件', flush=True)
        while True:
            connection, _ = server.accept()
            with connection:
                connection.settimeout(2)
                try:
                    with connection.makefile('r') as stream:
                        session_id = stream.readline().strip()
                    result = ALLOW if (ROOT / 'enabled').exists() else {}
                    connection.sendall(json.dumps(result).encode() + b'\n')
                    if result:
                        print(f'已批准：{session_id}', flush=True)
                except OSError as error:
                    print(f'审批事件未处理：{error}', file=sys.stderr, flush=True)


def hook():
    event = json.load(sys.stdin)
    if event.get('hook_event_name') != 'PermissionRequest':
        return {}
    try:
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(2)
            connection.connect(str(SOCKET))
            connection.sendall(event['session_id'].encode() + b'\n')
            with connection.makefile('r') as stream:
                return json.loads(stream.readline())
    except (OSError, ValueError):
        return {}


def configure_hook(codex_home):
    path = codex_home / 'hooks.json'
    config = json.loads(path.read_text()) if path.exists() else {}
    command = shlex.join([sys.executable, str(ROOT / 'service.py'), 'hook'])
    groups = config.setdefault('hooks', {}).setdefault('PermissionRequest', [])
    handler = {'type': 'command', 'command': command, 'timeout': 5}
    installed = False
    for group in groups:
        for existing in group.get('hooks', []):
            if existing.get('command') == command:
                existing.update(handler)
                installed = True
    if not installed:
        groups.append({'hooks': [handler]})
    codex_home.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(config, ensure_ascii=False, indent=2) + '\n')
    return path, command


def install():
    codex_home = Path(os.environ.get('CODEX_HOME', Path.home() / '.codex')).resolve()
    path, command = configure_hook(codex_home)
    with subprocess.Popen(['codex', 'app-server'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, text=True) as process:
        request_id = 0

        def rpc(method, params):
            nonlocal request_id
            request_id += 1
            process.stdin.write(json.dumps({'id': request_id, 'method': method, 'params': params}) + '\n')
            process.stdin.flush()
            for line in process.stdout:
                message = json.loads(line)
                if message.get('id') == request_id:
                    if 'error' in message:
                        raise RuntimeError(message['error'])
                    return message['result']
            raise RuntimeError('Codex app-server 提前退出')

        try:
            rpc('initialize', {'clientInfo': {'name': 'codex-auto-approve', 'version': '1.0'},
                               'capabilities': {'experimentalApi': True}})
            process.stdin.write('{"method":"initialized"}\n')
            process.stdin.flush()
            entries = rpc('hooks/list', {'cwds': [str(codex_home)]})['data']
            hooks = [h for entry in entries for h in entry['hooks']
                     if h.get('command') == command and h['sourcePath'] == str(path)
                     and h['eventName'] == 'permissionRequest']
            if not hooks:
                raise RuntimeError('Codex 未加载 PermissionRequest hook，请检查版本和 hooks 配置')
            rpc('config/batchWrite', {'edits': [{
                'keyPath': 'hooks.state', 'mergeStrategy': 'upsert',
                'value': {h['key']: {'trusted_hash': h['currentHash'], 'enabled': True} for h in hooks}
            }], 'reloadUserConfig': True})
        finally:
            process.terminate()
            process.wait(timeout=10)
    print('已配置 Codex 审批 hook。')


if __name__ == '__main__':
    action = sys.argv[1] if len(sys.argv) > 1 else 'serve'
    if action == 'hook':
        print(json.dumps(hook()))
    elif action == 'install':
        install()
    elif action == 'serve':
        serve()
    else:
        raise SystemExit(f'未知操作：{action}')

#!/usr/bin/env python3
"""Local dispatch receipts shared by Claude Code and Codex on this Mac."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from contextlib import contextmanager

ROOT = Path(os.environ.get('INBOX_DISPATCH_DIR', str(Path.home() / '.local/state/my-briefs/inbox-dispatch')))

@contextmanager
def locked():
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (ROOT / '.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield

def filename(key):
    return ROOT / (hashlib.sha256(key.encode()).hexdigest() + '.json')

def read(key):
    return json.loads(filename(key).read_text())

def save(value):
    target = filename(value['key'])
    temp = target.with_suffix('.tmp')
    with temp.open('w') as f:
        os.chmod(temp, 0o600)
        json.dump(value, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    temp.replace(target)

def prepare(key, spec):
    for field in ('cwd', 'title', 'prompt', 'reason', 'engine'):
        if not isinstance(spec.get(field), str) or not spec[field].strip():
            raise ValueError(f'{field} が必要です')
    if spec['engine'] not in ('claude', 'codex', 'current'):
        raise ValueError('engine は claude / codex / current')
    cwd = Path(spec['cwd']).expanduser()
    if not cwd.is_absolute() or not cwd.is_dir():
        raise ValueError('cwd は実在するフォルダの絶対パスにしてください')
    spec = {k: spec[k] for k in ('cwd', 'title', 'prompt', 'reason', 'engine')}
    spec['cwd'] = str(cwd.resolve())
    digest = hashlib.sha256(json.dumps(spec, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    with locked():
        if filename(key).exists():
            old = read(key)
            if old['digest'] != digest:
                raise ValueError('同じ依頼IDに別の内容が記録されています。status で既存の受け渡しを確認してください')
            return {**old, 'created': False}
        value = dict(spec, key=key, digest=digest, state='prepared', createdAt=time.time(),
                     launchName=f"inbox-{hashlib.sha256(key.encode()).hexdigest()[:12]} {spec['title']}",
                     configDir=os.environ.get('CLAUDE_CONFIG_DIR'))
        save(value)
        return {**value, 'created': True}

def transition(key, expected, **changes):
    with locked():
        value = read(key)
        if value['state'] not in expected:
            raise ValueError(f"現在の状態は {value['state']}。重複起動せず status で確認してください")
        value.update(changes, updatedAt=time.time())
        save(value)
        return value

def invoke(args, value):
    env = os.environ.copy()
    if value['configDir'] is None:
        env.pop('CLAUDE_CONFIG_DIR', None)
    else:
        env['CLAUDE_CONFIG_DIR'] = value['configDir']
    return subprocess.run(['claude', *args], cwd=value['cwd'], env=env,
                          capture_output=True, text=True, timeout=45)

def verify_claude(value):
    result = invoke(['agents', '--json', '--all', '--cwd', value['cwd']], value)
    if result.returncode:
        raise RuntimeError('claude agents の取得に失敗。自動再起動せず status で確認してください')
    rows = json.loads(result.stdout)
    matches = [r for r in rows if r.get('name') == value['launchName']
               and str(Path(r.get('cwd', '/')).resolve()) == value['cwd']]
    if len(matches) != 1 or not matches[0].get('sessionId'):
        raise RuntimeError('起動先を一意に確認できません。未確定のまま保持します')
    row = matches[0]
    if row.get('state') in ('failed', 'error'):
        raise RuntimeError('起動先がエラー状態です。ログを確認してください')
    return transition(value['key'], ('starting',), state='started', sessionId=row['sessionId'],
                      observed=row.get('state') or row.get('status'),
                      destination=f"claude attach {row.get('id') or row['sessionId']}")

def launch(key):
    with locked():
        value = read(key)
        if value['engine'] != 'claude' or value['state'] != 'prepared':
            raise ValueError('Claude の prepared 状態からだけ起動できます。重複起動は行いません')
        value.update(state='starting', updatedAt=time.time())
        save(value)
    # The CLI owns the session ID with --bg. A unique name is the recovery key.
    result = invoke(['--bg', '--name', value['launchName'], '--', value['prompt']], value)
    with locked():
        current = read(key)
        current['launchOutput'] = result.stdout + result.stderr
        save(current)
    if result.returncode:
        # Only this documented rejection proves that no session was created.
        if 'Workspace not trusted' in result.stdout + result.stderr:
            transition(key, ('starting',), state='blocked', error='workspace_not_trusted')
        raise RuntimeError('起動を確認できません。status の launchOutput を確認してください')
    return verify_claude(value)

def main():
    p = argparse.ArgumentParser()
    p.add_argument('command', choices=['prepare', 'launch', 'status', 'starting', 'record', 'reconcile', 'retry-unstarted'])
    p.add_argument('key', help='依頼ID。分割時は ID:1 などの固定キー')
    p.add_argument('--file')
    p.add_argument('--session')
    p.add_argument('--destination')
    p.add_argument('--host')
    a = p.parse_args()
    if a.command == 'prepare':
        if not a.file:
            p.error('--file が必要です')
        result = prepare(a.key, json.loads(Path(a.file).read_text()))
    elif a.command == 'launch':
        result = launch(a.key)
    elif a.command == 'retry-unstarted':
        result = transition(a.key, ('blocked',), state='prepared')
    elif a.command == 'starting':
        result = transition(a.key, ('prepared',), state='starting')
    elif a.command == 'record':
        if not a.session or not re.fullmatch(r'[A-Za-z0-9_-]+', a.session) or not a.destination:
            p.error('--session と --destination が必要です')
        result = transition(a.key, ('starting',), state='started', sessionId=a.session, destination=a.destination, hostId=a.host)
    elif a.command == 'reconcile':
        value = read(a.key)
        if value['engine'] != 'claude' or value['state'] != 'starting':
            raise ValueError('reconcile は Claude の starting 状態用です')
        result = verify_claude(value)
    else:
        with locked():
            result = read(a.key)
    print(json.dumps(result, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, RuntimeError, subprocess.SubprocessError) as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)

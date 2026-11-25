"""Audit the assembled payload, including precisely allowed CLI links."""
import hashlib
import json
import stat
import sys
from pathlib import Path

LINKS = {'usr/local/bin/claude': '/opt/cindy/resources/cloud-runtimes/claude/claude',
         'usr/local/bin/codex': '/opt/cindy/resources/cloud-runtimes/codex/bin/codex'}

def audit(root):
    rows = []
    for file in [root, *sorted(root.rglob('*'))]:
        name = file.relative_to(root).as_posix()
        st = file.lstat()
        if file.is_symlink():
            target = str(file.readlink())
            if LINKS.get(name) != target or not (root / target.lstrip('/')).is_file():
                raise ValueError('UNREVIEWED_LINK:' + name)
            rows.append({'path': name, 'link': target})
            continue
        mode = stat.S_IMODE(st.st_mode)
        if file.is_dir():
            if mode != 0o755: raise ValueError('DIRECTORY_PERMISSION:' + name)
            rows.append({'path': name, 'mode': mode})
        else:
            if not file.is_file() or mode not in (0o644, 0o755): raise ValueError('FILE_PERMISSION:' + name)
            with file.open('rb') as stream:
                sha = hashlib.file_digest(stream, 'sha256').hexdigest()
            rows.append({'path': name, 'mode': mode, 'sha256': sha})
    required = ['opt/cindy/Cindy', 'opt/cindy/chrome_crashpad_handler', 'usr/local/bin/cindy-seccomp',
                'usr/local/bin/cindy-linux-desktop', 'usr/local/bin/cindy-cloud-healthcheck.mjs',
                'usr/local/lib/cindy/keyring-check.mjs', 'usr/local/lib/cindy/github-device-login.py',
                'usr/local/lib/cindy/xfce-session', 'usr/bin/chromium']
    by_name = {r['path']: r for r in rows}
    for name in required:
        if by_name.get(name, {}).get('mode') != 0o755: raise ValueError('MISSING_EXECUTABLE:' + name)
    return {'version': 1, 'entries': rows, 'layerSha256': hashlib.sha256(json.dumps(rows, sort_keys=True).encode()).hexdigest()}

if __name__ == '__main__':
    print(json.dumps(audit(Path(sys.argv[1])), indent=2))

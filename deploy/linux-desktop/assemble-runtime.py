"""Assemble one application layer from build outputs and tracked source only."""
import json
import shutil
import sys
from pathlib import Path

recipe = Path(__file__).resolve().parent
artifact, layer = map(Path, sys.argv[1:])
layer.mkdir(exist_ok=False)
shutil.copytree(artifact / 'cindy', layer / 'opt/cindy')

def install(source, destination, mode=0o644):
    out = layer / destination
    out.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, out)
    out.chmod(mode)

for name, target in {
    'seccomp-launch.py': 'cindy-seccomp',
    'healthcheck.mjs': 'cindy-cloud-healthcheck.mjs',
}.items():
    install(recipe / 'runtime-support' / name, 'usr/local/bin/' + target, 0o755)
install(recipe / 'runtime-support/keyring-check.mjs', 'usr/local/lib/cindy/keyring-check.mjs', 0o755)
install(recipe / 'github-device-login.py', 'usr/local/lib/cindy/github-device-login.py', 0o755)
desktop = recipe / 'runtime-desktop-xfce'
install(artifact / 'plank/libplank.so.1.0.0', 'usr/lib/x86_64-linux-gnu/libplank.so.1.0.0')
shutil.copytree(artifact / 'plank/source', layer / 'usr/share/doc/cindy-plank/source')
for name in ['cindy-linux-desktop', 'cindy-dock-terminal', 'cindy-dock-chrome']:
    install(desktop / name, 'usr/local/bin/' + name, 0o755)
install(desktop / 'xfce-session', 'usr/local/lib/cindy/xfce-session', 0o755)
install(desktop / 'seccomp.json', 'usr/local/lib/cindy/seccomp.json')
for name in ['apply-appearance.py', 'apply-dock.py', 'apply-dock-apps.py']:
    install(desktop / name, 'usr/local/share/cindy/appearance/' + name)
for name in ['com.cindy.cloud-terminal.desktop', 'com.cindy.cloud-chrome.desktop']:
    install(desktop / name, 'usr/share/applications/' + name)
install(desktop / 'cindy-cloud-chrome.helper.desktop', 'usr/share/xfce4/helpers/cindy-cloud-chrome.desktop')
install(desktop / 'helpers.rc', 'etc/xdg/xfce4/helpers.rc')
install(recipe / 'runtime-support/chromium-compat', 'usr/bin/chromium', 0o755)
for name, target in {'claude': '/opt/cindy/resources/cloud-runtimes/claude/claude',
                     'codex': '/opt/cindy/resources/cloud-runtimes/codex/bin/codex'}.items():
    if not (layer / target.lstrip('/')).is_file(): raise RuntimeError('MISSING_AGENT:' + name)
    (layer / 'usr/local/bin' / name).symlink_to(target)
# Never inherit a build account's restrictive umask or setuid bits.
for file in layer.rglob('*'):
    if file.is_symlink(): continue
    file.chmod(0o755 if file.is_dir() or file.stat().st_mode & 0o111 else 0o644)
layer.chmod(0o755)

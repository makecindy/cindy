"""Bundle the pinned, verified agent assets which desktop Forge does not ship."""
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

def stage(source, artifact):
    destination = artifact / 'cindy/resources/cloud-runtimes'
    if destination.exists(): raise ValueError('AGENT_DESTINATION_EXISTS')
    claude_pin = json.loads((source / 'tools/claude/latest.json').read_text())
    codex_pin = json.loads((source / 'tools/codex-package/latest.json').read_text())
    claude = source / 'apps/claude-code-bin/linux-x64/claude'
    codex = source / 'apps/codex-package-bin/linux-x64'
    if claude.is_symlink() or not claude.is_file(): raise ValueError('CLAUDE_FILE_REQUIRED')
    with claude.open('rb') as f: sha = hashlib.file_digest(f, 'sha256').hexdigest()
    pin = claude_pin['runtimeAssets']['linux-x64']
    if sha != pin['sha256'] or claude.stat().st_size != pin['size']:
        raise ValueError('CLAUDE_PIN_MISMATCH')
    if codex.is_symlink() or not codex.is_dir() or any(p.is_symlink() for p in codex.rglob('*')):
        raise ValueError('CODEX_DIRECTORY_REQUIRED')
    pin = codex_pin['runtimeAssets']['linux-x64']
    if (codex / '.version').read_text().strip() != codex_pin['version'] or (codex / '.asset-digest.bin').read_text().strip() != pin['sha256']:
        raise ValueError('CODEX_PIN_MISMATCH')
    # Reuse the application's full directory-manifest and package validation.
    subprocess.run(['node', '--input-type=module', '-e', '''
import {pathToFileURL} from 'node:url';
const [source, directory, raw] = process.argv.slice(1), pin=JSON.parse(raw);
const {verifyDirDistManifest}=await import(pathToFileURL(source+'/tools/shared/dir-dist-manifest.mjs'));
const {validateCodexPackageDirectory}=await import(pathToFileURL(source+'/tools/codex-package/update.mjs'));
if(!verifyDirDistManifest(directory))throw Error('CODEX_MANIFEST_MISMATCH');
validateCodexPackageDirectory(directory,pin);
''', str(source), str(codex), json.dumps({'version': codex_pin['version'], 'target': pin['target'], 'entrypoint': pin['entrypoint']})], check=True)
    (destination / 'claude').mkdir(parents=True)
    shutil.copy2(claude, destination / 'claude/claude')
    shutil.copytree(codex, destination / 'codex')
    proof = {'claude': {'version': claude_pin['version'], 'sha256': sha},
             'codex': {'version': codex_pin['version'], 'archiveSha256': pin['sha256'], 'directoryVerified': True}}
    (artifact / 'agent-source-proof.json').write_text(json.dumps(proof, indent=2) + '\n')

if __name__ == '__main__': stage(*map(Path, sys.argv[1:]))

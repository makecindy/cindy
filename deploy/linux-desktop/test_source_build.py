import importlib.util
import io
import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import tarfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('runtime_audit', HERE / 'audit-runtime-layer.py')
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)
build_spec = importlib.util.spec_from_file_location('source_build', HERE / 'build-image.py')
build = importlib.util.module_from_spec(build_spec)
build_spec.loader.exec_module(build)
agent_spec = importlib.util.spec_from_file_location('stage_agents', HERE / 'stage-runtime-agents.py')
agents = importlib.util.module_from_spec(agent_spec)
agent_spec.loader.exec_module(agents)

timestamp_spec = importlib.util.spec_from_file_location('timestamps', HERE / 'normalize-timestamps.py')
timestamps = importlib.util.module_from_spec(timestamp_spec)
timestamp_spec.loader.exec_module(timestamps)

class GitFixture:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(exist_ok=True)
        self.run('init', '-q'); self.run('config', 'user.email', 'fixture@example.test'); self.run('config', 'user.name', 'Fixture')

    def run(self, *args):
        return subprocess.check_output(['git', '-C', str(self.root), *args], text=True).strip()

    def write(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def commit(self, message):
        self.run('add', '.'); self.run('commit', '-qm', message)
        return self.run('rev-parse', 'HEAD')

class PrepareTest(unittest.TestCase):
    def repository(self, folder):
        repo = GitFixture(Path(folder) / 'repo')
        for source in HERE.rglob('*'):
            if source.is_file() and '__pycache__' not in source.parts:
                path = repo.root / 'deploy/linux-desktop' / source.relative_to(HERE)
                path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, path)
        repo.write('pnpm-lock.yaml', 'lock')
        repo.write('apps/desktop/app.ts', 'first')
        return repo

    def invoke(self, repo, output, *args, prepare_only=True):
        command = ['build-image.py', '--tag', 'example:unique', '--output', str(output),
                   *(['--prepare-only'] if prepare_only else []), *args]
        with patch.object(build, 'REPO', repo.root), patch.object(sys, 'argv', command):
            build.main()

    def test_recipe_and_application_come_from_the_selected_revision(self):
        with tempfile.TemporaryDirectory() as folder:
            repo = self.repository(folder)
            first = repo.commit('first')
            repo.write('apps/desktop/app.ts', 'second')
            second = repo.commit('second')
            repo.write('apps/desktop/app.ts', 'uncommitted')
            for args, commit, content in [([], second, 'second'), (['--revision', first], first, 'first')]:
                with self.subTest(args=args):
                    output = Path(folder) / commit
                    self.invoke(repo, output, '--version', '1.2.3', '--cloud-revision', '4', *args)
                    context = output / 'context'
                    self.assertEqual((context / 'source/apps/desktop/app.ts').read_text(), content)
                    self.assertEqual((context / 'build-recipe/source-commit').read_text(), commit + '\n')
                    self.assertTrue((context / 'recipe/Dockerfile').is_file())
                    self.assertFalse((context / 'build-recipe/README.md').exists())
                    inputs = json.loads((output / 'build-inputs.json').read_text())
                    self.assertEqual(inputs, json.loads((context / 'recipe/build-inputs.json').read_text()))
                    self.assertEqual(inputs['sourceCommit'], commit)
                    self.assertEqual(inputs['baseRecipeCommit'], first)
                    self.assertEqual(inputs['version'], {'upstreamVersion': '1.2.3', 'cloudRevision': 4})
                    combined = (context / 'Dockerfile.combined').read_text()
                    self.assertNotIn('${BASE_IMAGE}', combined)
                    self.assertIn('FROM runtime-base-slim AS runtime', combined)

    def test_both_build_paths_audit_the_image_of_the_revision(self):
        import release_guard
        run = subprocess.run
        def no_local_image(args, **kwargs):
            if args[:3] == ['docker', 'image', 'inspect']: return subprocess.CompletedProcess(args, 1)
            return run(args, **kwargs)
        with tempfile.TemporaryDirectory() as folder:
            repo = self.repository(folder); commit = repo.commit('first')
            entrypoint = hashlib.sha256((HERE / 'runtime-desktop-xfce/cindy-linux-desktop').read_bytes()).hexdigest()
            base = {'Id': 'base-id', 'RootFS': {'Layers': ['base']}}
            runtime = {'Id': 'runtime-id', 'Os': 'linux', 'Architecture': 'amd64', 'Size': 1,
                       'RootFS': {'Layers': ['base', 'application']},
                       'Config': {'User': 'cindy', 'Entrypoint': release_guard.ENTRYPOINT, 'Cmd': release_guard.CMD,
                                  'Labels': {'io.cindy.source-commit': commit, 'io.cindy.entrypoint-sha256': entrypoint}}}
            inspect = lambda *args: json.dumps([base if args[-1].endswith('-base') else runtime])
            mirror = ['--source-arg', 'DEBIAN_BUILD_MIRROR=https://mirror.example.com']
            cache = ['--builder', 'fixture', '--cache-repository', 'registry.example.com/cindy/cache']
            for name, args, steps in [('local', mirror, ['base-build', 'runtime-build', 'build-records']),
                                      ('builder', [*mirror, *cache], ['prepare-build', 'materialize-build', 'full-build'])]:
                with self.subTest(name), patch.object(build, 'run_build') as builds, \
                        patch.object(build, 'docker', side_effect=inspect), \
                        patch.object(build.subprocess, 'run', side_effect=no_local_image), redirect_stdout(io.StringIO()):
                    output = Path(folder) / name
                    self.invoke(repo, output, '--version', '1.2.3', *args, prepare_only=False)
                self.assertEqual([call.args[1] for call in builds.call_args_list], steps)
                values = builds.call_args_list[1].args[2]
                if name == 'builder':
                    values = [f'{k}={v}' for k, v in
                              json.loads((output / 'docker-bake.json').read_text())['target']['runtime']['args'].items()]
                for value in ['CINDY_SOURCE_COMMIT=' + commit, 'CINDY_UPSTREAM_VERSION=1.2.3', 'CINDY_CLOUD_REVISION=1',
                              'CINDY_ENTRYPOINT_SHA256=' + entrypoint, 'SOURCE_DATE_EPOCH=1789344000',
                              'DEBIAN_BUILD_MIRROR=https://mirror.example.com']:
                    self.assertIn(value, values)
                result = json.loads((output / 'result.json').read_text())
                self.assertEqual((result['imageId'], result['sourceCommit']), ('runtime-id', commit))

    def test_rejects_uncommitted_recipe_and_invalid_versions(self):
        with tempfile.TemporaryDirectory() as folder:
            repo = self.repository(folder); repo.commit('first')
            output = Path(folder) / 'output'
            invalid = [['--version', v] for v in ('1.2', '1.2.3.4', 'v1.2.3', '01.2.3', '1.2.3-cloud.1', '1.2.3\n')]
            invalid += [['--version', '1.2.3', '--cloud-revision', v] for v in ('0', '-1', 'x')]
            invalid += [[], ['--version', '1.2.3', '--tag', 'example:1.2.3']]
            repo.write('deploy/linux-desktop/untracked', 'change')
            for args in [*invalid, ['--version', '1.2.3']]:
                with self.subTest(args=args), redirect_stderr(io.StringIO()) as errors, self.assertRaises(SystemExit):
                    self.invoke(repo, output, *args)
                self.assertEqual('commit the recipe' in errors.getvalue(), args not in invalid)
            self.assertFalse(output.exists())

class SourceLfsTest(unittest.TestCase):
    # An exported LFS pointer would break native modules at run time: it must
    # hydrate to the exact oid/size or abort before packaging.
    def test_export_hydrates_pointer_and_rejects_missing_or_corrupt_objects(self):
        payload = b'\x7fELF fixture'
        sha = hashlib.sha256(payload).hexdigest()
        pointer = f'version https://git-lfs.github.com/spec/v1\noid sha256:{sha}\nsize {len(payload)}\n'.encode()
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode='w') as archive:
            for name, content in [('native/vec0.so', pointer), ('README', b'ordinary source')]:
                item = tarfile.TarInfo(name); item.size = len(content); item.mode = 0o755; item.mtime = 1234
                archive.addfile(item, io.BytesIO(content))
        for output, code, error in [(payload, 0, None), (pointer, 0, 'LFS_OBJECT_MISMATCH'),
                                    (b'x'*len(payload), 0, 'LFS_OBJECT_MISMATCH'),
                                    (payload+b'x', 0, 'LFS_OBJECT_MISMATCH'),
                                    (b'', 1, 'LFS_OBJECT_UNAVAILABLE')]:
            with self.subTest(output=output, code=code), tempfile.TemporaryDirectory() as folder:
                def smudge(args, **kwargs):
                    self.assertEqual(kwargs['input'], pointer)
                    kwargs['stdout'].write(output)
                    return subprocess.CompletedProcess(args, code)
                root = Path(folder) / 'source'
                with patch.object(build, 'git', return_value=data.getvalue()), patch.object(build.subprocess, 'run', side_effect=smudge):
                    if error:
                        with self.assertRaisesRegex(ValueError, error): build.export('revision', root)
                        self.assertEqual((root/'native/vec0.so').read_bytes(), pointer)
                    else:
                        proof = build.export('revision', root)
                        self.assertEqual(proof, {'native/vec0.so': {'sha256': sha, 'size': len(payload)}})
                        target = root/'native/vec0.so'
                        self.assertEqual(target.read_bytes(), payload)
                        self.assertEqual(target.stat().st_mode & 0o777, 0o755)
                        self.assertEqual(target.stat().st_mtime, 1234)
                        self.assertEqual((root/'README').read_bytes(), b'ordinary source')

class BuildTransportTest(unittest.TestCase):
    # A single metadata transport failure followed by success must resume;
    # deterministic failures and repeated resets stop. Failure logs are kept.
    def test_source_transport_retry_preserves_failure_and_is_bounded(self):
        transient = 'ERROR: failed to solve: failed to resolve source metadata for registry.example.com/tool@sha256:abc: read: connection reset by peer\n'
        for outputs, succeeds in [(['build complete\n'], True),
                                  ([transient, 'build complete\n'], True),
                                  ([transient, transient], False),
                                  (['ERROR: failed to solve: checksum mismatch\n'], False),
                                  (['ERROR: failed to solve: failed to resolve source metadata: unauthorized\n'], False),
                                  (['ERROR: failed to solve: process RUN failed: connection reset by peer\n'], False)]:
            with self.subTest(outputs=outputs), tempfile.TemporaryDirectory() as folder:
                root = Path(folder); calls = []
                def execute(args, **kwargs):
                    text = outputs[len(calls)]; calls.append(args)
                    kwargs['stdout'].write(text)
                    return subprocess.CompletedProcess(args, int(text.startswith('ERROR:')))
                with patch.object(build.subprocess, 'run', side_effect=execute):
                    if succeeds:
                        build.run_build(root, 'prepare-build', ['docker', 'buildx', 'bake'], root)
                    else:
                        with self.assertRaisesRegex(RuntimeError, 'prepare-build failed'):
                            build.run_build(root, 'prepare-build', ['docker', 'buildx', 'bake'], root)
                self.assertEqual(len(calls), len(outputs))
                self.assertTrue(all(args == ['docker', 'buildx', 'bake'] for args in calls))
                self.assertEqual((root / 'prepare-build.log').read_text(), outputs[-1])
                if len(outputs) == 2:
                    self.assertEqual((root / 'prepare-build-attempt-1.log').read_text(), transient)
                attempts = json.loads((root / 'prepare-build-attempts.json').read_text())
                self.assertEqual([a['exitCode'] for a in attempts], [int(s.startswith('ERROR:')) for s in outputs])

class TimestampTest(unittest.TestCase):
    # New/old mtimes and an external symlink: bytes, permissions and targets
    # must survive, and a second pass must change nothing.
    def test_clamp_preserves_payload_permissions_links_and_older_times(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / 'layer'; root.mkdir()
            outside = Path(folder) / 'outside'; outside.write_bytes(b'outside')
            file = root / 'file'; file.write_bytes(b'payload'); file.chmod(0o751)
            old = root / 'old'; old.write_bytes(b'old')
            hard = root / 'hard'; os.link(file, hard)
            link = root / 'symlink'; link.symlink_to(outside)
            for p in (root, file, hard, link, outside):
                os.utime(p, ns=(2_000_000_000_123456789, 2_000_000_000_123456789), follow_symlinks=False)
            os.utime(old, ns=(1_000_000_000, 1_000_000_000))
            before = outside.stat()
            self.assertGreater(timestamps.normalize(root, 1789344000), 0)
            self.assertEqual(file.read_bytes(), b'payload')
            self.assertEqual(file.stat().st_mode & 0o7777, 0o751)
            self.assertEqual(file.stat().st_ino, hard.stat().st_ino)
            self.assertEqual(file.stat().st_mtime_ns, 1789344000_000000000)
            self.assertEqual(link.readlink(), outside)
            self.assertEqual(link.lstat().st_mtime_ns, 1789344000_000000000)
            self.assertEqual(outside.stat().st_mtime_ns, before.st_mtime_ns)
            self.assertEqual(old.stat().st_mtime_ns, 1_000_000_000)
            self.assertEqual(timestamps.normalize(root, 1789344000), 0)

    def test_rejects_live_root_and_link_root_before_mutation(self):
        with tempfile.TemporaryDirectory() as folder:
            link = Path(folder) / 'link'; link.symlink_to(folder)
            for root in (Path('/'), link):
                with self.assertRaisesRegex(ValueError, 'STAGED_DIRECTORY_REQUIRED'):
                    timestamps.normalize(root, 1789344000)

class AgentStagingTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'
        self.artifact = self.root / 'artifact'
        for tool in ['shared', 'codex-package']:
            shutil.copytree(HERE.parents[1] / 'tools' / tool, self.source / 'tools' / tool)
        self.claude = self.source / 'apps/claude-code-bin/linux-x64/claude'
        self.claude.parent.mkdir(parents=True)
        self.claude.write_bytes(b'synthetic CLI')
        (self.source / 'tools/claude').mkdir()
        (self.source / 'tools/claude/latest.json').write_text(json.dumps({'version': 'fixture', 'runtimeAssets': {'linux-x64': {'size': 13, 'sha256': hashlib.sha256(b'synthetic CLI').hexdigest()}}}))
        self.codex = self.source / 'apps/codex-package-bin/linux-x64'
        for path in ['bin/codex', 'bin/codex-code-mode-host', 'codex-path/rg', 'codex-resources/helper']:
            p = self.codex / path; p.parent.mkdir(parents=True, exist_ok=True); p.write_text('fixture')
        (self.codex / 'codex-package.json').write_text(json.dumps({'layoutVersion': 1, 'version': 'fixture', 'target': 'x86_64-unknown-linux-musl', 'variant': 'codex', 'entrypoint': 'bin/codex', 'resourcesDir': 'codex-resources', 'pathDir': 'codex-path'}))
        (self.codex / '.version').write_text('fixture')
        (self.codex / '.asset-digest.bin').write_text('a' * 64)
        (self.source / 'tools/codex-package/latest.json').write_text(json.dumps({'version': 'fixture', 'runtimeAssets': {'linux-x64': {'sha256': 'a' * 64, 'target': 'x86_64-unknown-linux-musl', 'entrypoint': 'bin/codex'}}}))
        rows = [{'path': p.relative_to(self.codex).as_posix(), 'size': p.stat().st_size, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in self.codex.rglob('*') if p.is_file() and p.name != '.version']
        (self.codex / '.manifest').write_text(json.dumps({'files': rows}))

    def test_full_cli_package_is_staged_and_recorded(self):
        agents.stage(self.source, self.artifact)
        self.assertEqual((self.artifact / 'cindy/resources/cloud-runtimes/claude/claude').read_bytes(), b'synthetic CLI')
        self.assertTrue((self.artifact / 'cindy/resources/cloud-runtimes/codex/codex-resources/helper').is_file())
        self.assertTrue(json.loads((self.artifact / 'agent-source-proof.json').read_text())['codex']['directoryVerified'])

    def test_rejects_corrupt_binary_before_copy(self):
        self.claude.write_bytes(b'changed bytes')
        with self.assertRaisesRegex(ValueError, 'CLAUDE_PIN_MISMATCH'): agents.stage(self.source, self.artifact)
        self.assertFalse(self.artifact.exists())

    def test_rejects_agent_links_and_unlisted_payload(self):
        (self.codex / 'escape').symlink_to(self.claude)
        with self.assertRaisesRegex(ValueError, 'CODEX_DIRECTORY_REQUIRED'): agents.stage(self.source, self.artifact)
        (self.codex / 'escape').unlink()
        (self.codex / 'unexpected').write_text('unverified extra')
        with self.assertRaises(subprocess.CalledProcessError): agents.stage(self.source, self.artifact)
        self.assertFalse(self.artifact.exists())

class BuildGraphTest(unittest.TestCase):
    def test_local_copy_inputs_are_allowed_through_dockerignore(self):
        # COPY inputs may exist on disk yet disappear from BuildKit's context.
        # Check the real Dockerfile's input roots, including parent directories.
        rules = (HERE / 'Dockerfile.dockerignore').read_text().splitlines()
        self.assertEqual(rules[0], '*')
        roots = set()
        for line in (HERE / 'Dockerfile').read_text().splitlines():
            if not line.startswith('COPY '):
                continue
            parts = shlex.split(line)
            if parts and parts[0] == 'COPY' and not any(p.startswith('--from=') for p in parts):
                roots.update(p.split('/')[0] for p in parts[1:-1] if not p.startswith('--'))
        for root in roots:
            with self.subTest(root=root):
                self.assertIn('!' + root + '/', rules)
                self.assertIn('!' + root + '/**', rules)
        # Dependency caches and Git metadata remain excluded after the allowlist.
        for excluded in ['**/node_modules', '**/.git', '**/__pycache__']:
            self.assertGreater(rules.index(excluded), max(i for i, r in enumerate(rules) if r.startswith('!')))

    def test_registry_cache_serves_fresh_builders_without_overlapping_writers(self):
        targets = build.bake_plan(Path('/records'), 'example:unique', 'app-commit', 'sha', False,
            '1.2.3', 2, 'base-commit', 'registry.example.com/cindy/build-cache',
            {'DEBIAN_BUILD_MIRROR': 'https://mirror.example.com'})['target']
        self.assertEqual(targets['base']['args']['CINDY_BASE_SOURCE_COMMIT'], 'base-commit')
        self.assertEqual(targets['runtime']['args']['CINDY_SOURCE_COMMIT'], 'app-commit')
        self.assertEqual(targets['runtime']['args']['CINDY_CLOUD_REVISION'], '2')
        for target in targets.values():
            self.assertEqual(target['args']['CINDY_UPSTREAM_VERSION'], '1.2.3')
            self.assertEqual(target['args']['DEBIAN_BUILD_MIRROR'], 'https://mirror.example.com')
        self.assertEqual(targets['base']['args'], targets['runtime']['args'])
        exports = [t['cache-to'][0] for t in targets.values() if 'cache-to' in t]
        self.assertEqual(len(exports), 2)
        self.assertEqual(len(set(exports)), 2)
        self.assertTrue(all('ignore-error' not in x for x in exports))
        self.assertIn('mode=min', targets['prepared']['cache-to'][0])
        self.assertNotIn('cache-to', targets['runtime'])
        self.assertEqual(targets['records']['cache-from'], targets['runtime']['cache-from'])
        self.assertNotIn('cache-to', targets['records'])
        # An exported probe could become a metadata-only hit on fresh builders.
        # Force physical restoration through a separate, unexported target.
        self.assertNotIn('cache-to', targets['materialize'])
        self.assertEqual(targets['materialize']['target'], 'prepared-materialized')
        self.assertEqual(targets['materialize']['cache-from'], targets['prepared']['cache-from'])
        # No target may merge the overlapping max/min parent histories. After
        # hydration, downstream targets use the local snapshot, not new imports.
        self.assertEqual(len(targets['prepared']['cache-from']), 1)
        self.assertTrue(targets['prepared']['cache-from'][0].endswith(':cindy-cloud-cn-amd64-prepared'))
        self.assertEqual(len(targets['base']['cache-from']), 1)
        self.assertTrue(targets['base']['cache-from'][0].endswith(':cindy-cloud-cn-amd64-base'))
        self.assertEqual(targets['runtime']['cache-from'], [])
        self.assertEqual(targets['records']['cache-from'], [])

    def test_cold_rebuild_does_not_import_cache_or_accept_injected_options(self):
        targets = build.bake_plan(Path('/records'), 'example:unique', 'commit', 'sha', True, '1.2.3', 1,
            'base', cache_repository='registry.example.com/cindy/build-cache')['target']
        self.assertTrue(all(t['cache-from'] == [] for t in targets.values()))
        for bad in ['https://registry.example.com/repo', 'user:password@registry.example.com/repo',
                    'registry.example.com/repo:latest', 'registry.example.com/repo,mode=min', '../repo']:
            with self.subTest(value=bad), self.assertRaises(ValueError): build.registry_cache(bad)

    def test_docs_and_provenance_do_not_invalidate_base_or_application_inputs(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            recipe = root / 'recipe'
            files = {p: 'locked input' for p in build.BASE_INPUTS}
            files.update({'README.md': 'docs', 'build-inputs.json': 'commit metadata',
                'runtime-base/README.md': 'base docs',
                'runtime-guidance/default.md': 'runtime prompt',
                'runtime-input/bridge.mjs': 'runtime code', 'runtime-input/bridge.test.mjs': 'test'})
            for name, data in files.items():
                p=recipe/name; p.parent.mkdir(parents=True,exist_ok=True); p.write_text(data)
            build.stage_recipe_contexts(root)
            def snapshot(directory):
                return {p.relative_to(directory).as_posix():p.read_bytes() for p in directory.rglob('*') if p.is_file()}
            base=snapshot(root/'base-recipe'); app=snapshot(root/'build-recipe')
            self.assertEqual(set(base), set(build.BASE_INPUTS))
            self.assertIn('runtime-guidance/default.md', app)
            self.assertNotIn('build-inputs.json',app)
            for name in ['README.md','build-inputs.json','runtime-base/README.md','runtime-input/bridge.test.mjs']:
                (recipe/name).write_text('changed unrelated input')
            shutil.rmtree(root/'base-recipe'); shutil.rmtree(root/'build-recipe')
            build.stage_recipe_contexts(root)
            self.assertEqual(base,snapshot(root/'base-recipe'))
            self.assertEqual(app,snapshot(root/'build-recipe'))
            (recipe/'runtime-base/packages.lock').write_text('changed lock')
            (recipe/'runtime-guidance/default.md').write_text('changed prompt')
            shutil.rmtree(root/'base-recipe'); shutil.rmtree(root/'build-recipe')
            build.stage_recipe_contexts(root)
            self.assertNotEqual(base,snapshot(root/'base-recipe'))
            self.assertNotEqual(app,snapshot(root/'build-recipe'))

    def test_base_recipe_commit_is_the_last_change_of_a_base_input(self):
        with tempfile.TemporaryDirectory() as folder:
            repo = GitFixture(folder)
            for name in build.BASE_INPUTS: repo.write('deploy/linux-desktop/' + name, 'locked ' + name)
            base = repo.commit('base')
            repo.write('other', 'application change')
            application = repo.commit('application')
            repo.write('deploy/linux-desktop/runtime-base/packages.lock', 'changed lock')
            changed = repo.commit('changed')
            with patch.object(build, 'REPO', repo.root):
                self.assertEqual(build.base_recipe_commit(base), base)
                self.assertEqual(build.base_recipe_commit(application), base)
                self.assertEqual(build.base_recipe_commit(changed), changed)

    def test_base_recipe_commit_requires_the_inputs_in_history(self):
        with tempfile.TemporaryDirectory() as folder:
            repo = GitFixture(folder)
            repo.write('other', 'no recipe')
            with patch.object(build, 'REPO', repo.root), self.assertRaisesRegex(ValueError, 'BASE_RECIPE_COMMIT_REQUIRED'):
                build.base_recipe_commit(repo.commit('no recipe'))

    def test_only_https_mirrors_of_known_downloads_can_be_overridden(self):
        self.assertEqual(build.source_args(['DEBIAN_SNAPSHOT_URL=https://mirror.example.com/a?b=c']),
                         {'DEBIAN_SNAPSHOT_URL': 'https://mirror.example.com/a?b=c'})
        declared = {line.split()[1].split('=')[0] for name in ('Dockerfile', 'runtime-base/Dockerfile')
                    for line in (HERE / name).read_text().splitlines() if line.startswith('ARG ')}
        self.assertLessEqual(set(build.SOURCE_ARGS), declared)
        for bad in ['DEBIAN_SNAPSHOT_URL', 'DEBIAN_SNAPSHOT_URL=http://mirror.example.com',
                    'NODE_IMAGE=https://mirror.example.com', 'CHROME_DEB_URL=https://a b']:
            with self.subTest(value=bad), self.assertRaisesRegex(ValueError, 'INVALID_SOURCE_ARG'):
                build.source_args([bad])

    def test_remote_targets_use_fresh_base_without_registry_roundtrip(self):
        plan = build.bake_plan(Path('/private/records'), 'example:unique', 'commit', 'entrysha', True,
                               '1.2.3', 1, 'base')['target']
        self.assertEqual(plan['base']['target'], 'runtime-base-slim')
        for name in ['runtime', 'records']:
            self.assertEqual(plan[name]['contexts'], {'base-recipe': './base-recipe'})
            self.assertEqual(plan[name]['dockerfile'], plan['base']['dockerfile'])
            self.assertNotIn('BASE_IMAGE', plan[name]['args'])
            self.assertEqual(plan[name]['args']['CINDY_SOURCE_COMMIT'], 'commit')
            self.assertTrue(plan[name]['no-cache'])
        self.assertEqual(plan['records']['target'], 'build-records')
        self.assertEqual(plan['records']['output'], ['type=local,dest=/private/records/records'])
        self.assertTrue(all('push=' not in out for t in plan.values() for out in t['output']))

class RuntimeLayerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.artifact = self.root / 'artifact'
        for name in ['Cindy', 'chrome_crashpad_handler',
                     'resources/cloud-runtimes/claude/claude',
                     'resources/cloud-runtimes/codex/bin/codex']:
            p = self.artifact / 'cindy' / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text('fixture executable\n')
            p.chmod(0o700)
        (self.artifact / 'plank/source').mkdir(parents=True)
        (self.artifact / 'plank/libplank.so.1.0.0').write_bytes(b'synthetic Plank library')
        (self.artifact / 'plank/source/notice').write_text('synthetic corresponding source')
        self.layer = self.root / 'layer'
        subprocess.run([sys.executable, str(HERE / 'assemble-runtime.py'),
                        str(self.artifact), str(self.layer)], check=True)

    def test_complete_layer_and_sources(self):
        result = audit.audit(self.layer)
        self.assertTrue(result['layerSha256'])
        self.assertEqual((self.layer / 'usr/lib/x86_64-linux-gnu/libplank.so.1.0.0').read_bytes(),
                         (self.artifact / 'plank/libplank.so.1.0.0').read_bytes())
        self.assertEqual((self.layer / 'usr/share/doc/cindy-plank/source/notice').read_text(),
                         'synthetic corresponding source')
        self.assertEqual((self.layer / 'usr/local/bin/cindy-seccomp').read_bytes(),
                         (HERE / 'runtime-support/seccomp-launch.py').read_bytes())
        self.assertEqual((self.layer / 'usr/bin/chromium').read_bytes(),
                         (HERE / 'runtime-support/chromium-compat').read_bytes())
        self.assertEqual((self.layer / 'etc/xdg/xfce4/helpers.rc').read_bytes(),
                         (HERE / 'runtime-desktop-xfce/helpers.rc').read_bytes())
        self.assertIn(b'X-XFCE-Binaries=cindy-dock-chrome;',
                      (self.layer / 'usr/share/xfce4/helpers/cindy-cloud-chrome.desktop').read_bytes())
        self.assertEqual((self.layer / 'usr/local/bin/codex').readlink(),
                         Path('/opt/cindy/resources/cloud-runtimes/codex/bin/codex'))

    def test_installed_programs(self):
        installed = {p.relative_to(self.layer / 'usr/local').as_posix()
                     for folder in ('bin', 'lib/cindy') for p in (self.layer / 'usr/local' / folder).iterdir()}
        self.assertEqual(installed, {
            'bin/cindy-seccomp', 'bin/cindy-linux-desktop', 'bin/cindy-cloud-healthcheck.mjs',
            'bin/cindy-dock-terminal', 'bin/cindy-dock-chrome', 'bin/claude', 'bin/codex',
            'lib/cindy/xfce-session', 'lib/cindy/keyring-check.mjs', 'lib/cindy/seccomp.json',
            'lib/cindy/github-device-login.py'})
        # Everything the wrapper starts from this layer is installed.
        wrapper = (self.layer / 'usr/local/bin/cindy-linux-desktop').read_text()
        for name in re.findall(r'/usr/local/(lib/cindy/[a-z.-]+|bin/[a-z.-]+)', wrapper):
            self.assertIn(name, installed)

    def test_shell_scripts_parse(self):
        desktop = HERE / 'runtime-desktop-xfce'
        for script in [desktop / 'cindy-linux-desktop', desktop / 'xfce-session', desktop / 'plank/build.sh',
                       HERE / 'build-runtime.sh', HERE / 'prepare-linux.sh']:
            subprocess.run(['bash', '-n', str(script)], check=True)

    def test_rejects_restrictive_directories_and_setuid(self):
        directory = self.layer / 'opt/cindy'
        directory.chmod(0o700)
        with self.assertRaisesRegex(ValueError, 'DIRECTORY_PERMISSION'): audit.audit(self.layer)
        directory.chmod(0o755)
        (directory / 'Cindy').chmod(0o4755)
        with self.assertRaisesRegex(ValueError, 'FILE_PERMISSION'): audit.audit(self.layer)

    def test_rejects_missing_entrypoint_and_escaping_links(self):
        entry = self.layer / 'usr/local/bin/cindy-seccomp'
        entry.unlink()
        with self.assertRaisesRegex(ValueError, 'MISSING_EXECUTABLE'): audit.audit(self.layer)
        entry.symlink_to('/etc/passwd')
        with self.assertRaisesRegex(ValueError, 'UNREVIEWED_LINK'): audit.audit(self.layer)

if __name__ == '__main__': unittest.main()

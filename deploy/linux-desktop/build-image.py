#!/usr/bin/env python3
"""Build the cloud runtime image from one Git revision into the local Docker image store.

Optionally exports build cache to a registry. Never publishes the image."""
import argparse
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
BASE_INPUTS = ('runtime-base/Dockerfile', 'runtime-base/packages.lock',
               'runtime-base/base_lock.py', 'runtime-fonts/stage-emoji-font.py',
               'normalize-timestamps.py')
SOURCE_DATE_EPOCH = '1789344000'
VERSION = r'(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*)){2}'
# Download locations that may point at a mirror of the same artifacts.
SOURCE_ARGS = ('DEBIAN_SNAPSHOT_URL', 'DEBIAN_BUILD_MIRROR', 'CHROME_DEB_URL', 'GH_TARBALL_URL',
               'PLANK_SOURCE_URL', 'PLANK_DEBIAN_SOURCE_URL')

def stage_recipe_contexts(context):
    """Keep docs, tests and build records out of expensive filesystem inputs."""
    recipe = context / 'recipe'
    for name in BASE_INPUTS:
        target = context / 'base-recipe' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(recipe / name, target)
    for source in recipe.rglob('*'):
        relative = source.relative_to(recipe)
        if relative.parts[0] == 'runtime-base' or not source.is_file():
            continue
        if (source.name == 'build-inputs.json' or source.name.startswith('test_')
                or '.test.' in source.name or source.name.endswith('.pyc')
                or source.name == 'README.md'
                or (len(relative.parts) == 1 and source.suffix == '.md')):
            continue
        target = context / 'build-recipe' / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)

def write_combined_dockerfile(context):
    """Use one stage graph; target:base loses application cache on fresh builders.

    The two checked-in recipes remain authoritative. Only source paths and the
    base provenance argument are adapted; no downloaded Cindy image is used.
    """
    base = (context / 'recipe/runtime-base/Dockerfile').read_text()
    app = (context / 'recipe/Dockerfile').read_text()
    base = base.replace('CINDY_SOURCE_COMMIT', 'CINDY_BASE_SOURCE_COMMIT')
    base = base.replace('type=bind,source=', 'type=bind,from=base-recipe,source=')
    app = '\n'.join(line for line in app.splitlines()
                    if not line.startswith('# syntax=') and line != 'ARG BASE_IMAGE')
    if app.count('FROM ${BASE_IMAGE}') != 2:
        raise ValueError('APPLICATION_BASE_STAGES_CHANGED')
    app = app.replace('FROM ${BASE_IMAGE}', 'FROM runtime-base-slim')
    (context / 'Dockerfile.combined').write_text(base + '\n' + app + '\n')
    shutil.copyfile(context / 'recipe/Dockerfile.dockerignore',
                    context / 'Dockerfile.combined.dockerignore')

def registry_cache(repository):
    # No tag, digest, URL credentials, or Buildx CSV options in the input.
    if not re.fullmatch(r'[a-z0-9][a-z0-9.-]+(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)+', repository):
        raise ValueError('INVALID_BUILD_CACHE_REPOSITORY')
    return {'base': repository + ':cindy-cloud-cn-amd64-base',
            'prepared': repository + ':cindy-cloud-cn-amd64-prepared'}

def git(*args, env=None):
    return subprocess.check_output(['git', *args], cwd=REPO, env=env)

def digest(data):
    return hashlib.sha256(data).hexdigest()

def base_recipe_commit(revision):
    """The commit that last changed the base inputs: the base image's label and cache key.

    Other commits leave it unchanged, so they reuse the cached base."""
    paths = ['deploy/linux-desktop/' + p for p in BASE_INPUTS]
    commit = git('log', '-1', '--format=%H', revision, '--', *paths).decode().strip()
    if not re.fullmatch('[a-f0-9]{40}', commit):
        raise ValueError('BASE_RECIPE_COMMIT_REQUIRED')
    return commit

def export(revision, destination, *paths):
    destination.mkdir(parents=True, exist_ok=True)
    # Some Git installations apply LFS filters to archive, others export pointers.
    # Normalize to pointers so both paths use the same verified hydration below.
    data = git('archive', revision, *paths, env={**os.environ, 'GIT_LFS_SKIP_SMUDGE': '1'})
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        archive.extractall(destination, filter='data')
        pointers = [m.name for m in archive.getmembers() if m.isfile() and m.size <= 1024]
    lfs = {}
    for name in pointers:
        target = destination / name
        pointer = target.read_bytes()
        if not pointer.startswith(b'version https://git-lfs.github.com/spec/v1'):
            continue
        match = re.fullmatch(rb'version https://git-lfs.github.com/spec/v1\noid sha256:([a-f0-9]{64})\nsize ([0-9]+)\n', pointer)
        if not match:
            raise ValueError('INVALID_LFS_POINTER:' + name)
        sha, size = match[1].decode(), int(match[2])
        before = target.stat()
        # Archive pointers can survive even when checkout hydrated the files.
        # Resolve the committed pointer through Git LFS (local object cache first),
        # never copy potentially dirty worktree bytes or trust download success.
        with tempfile.NamedTemporaryFile(dir=target.parent) as staged:
            result = subprocess.run(['git', '-c', 'lfs.fetchinclude=', '-c', 'lfs.fetchexclude=',
                                     '-c', 'lfs.skipdownloaderrors=false', 'lfs', 'smudge', name],
                                    cwd=REPO, input=pointer, stdout=staged, stderr=subprocess.PIPE,
                                    env={**os.environ, 'GIT_LFS_SKIP_SMUDGE': '0',
                                         'GIT_LFS_SKIP_DOWNLOAD_ERRORS': '0'})
            if result.returncode:
                raise ValueError('LFS_OBJECT_UNAVAILABLE:' + name)
            staged.flush()
            staged.seek(0)
            actual = hashlib.file_digest(staged, 'sha256').hexdigest()
            if os.fstat(staged.fileno()).st_size != size or actual != sha:
                raise ValueError('LFS_OBJECT_MISMATCH:' + name)
            staged.seek(0)
            with target.open('wb') as out:
                shutil.copyfileobj(staged, out)
        os.chmod(target, before.st_mode & 0o777)
        os.utime(target, ns=(before.st_atime_ns, before.st_mtime_ns))
        lfs[name] = {'sha256': sha, 'size': size}
    return lfs

def prepare(output, revision, version, cloud_revision):
    """Export recipe and application from one revision into separate build contexts."""
    context = output / 'context'
    recipe_lfs = export(revision, output / 'recipe-export', 'deploy/linux-desktop')
    source = context / 'source'
    source_lfs = export(revision, source)
    recipe = context / 'recipe'
    (output / 'recipe-export/deploy/linux-desktop').rename(recipe)
    inputs = {'sourceCommit': revision, 'baseRecipeCommit': base_recipe_commit(revision),
              'version': {'upstreamVersion': version, 'cloudRevision': cloud_revision},
              'region': 'cn', 'platform': 'linux/amd64',
              'lfsFiles': {'recipe': recipe_lfs, 'source': source_lfs},
              'lockSha256': digest((source / 'pnpm-lock.yaml').read_bytes()),
              'recipeFiles': {p.relative_to(recipe).as_posix(): digest(p.read_bytes())
                              for p in sorted(recipe.rglob('*')) if p.is_file()}}
    stage_recipe_contexts(context)
    # The exported source has no .git; the packaging step reads its commit here.
    (context / 'build-recipe/source-commit').write_text(revision + '\n')
    (recipe / 'build-inputs.json').write_text(json.dumps(inputs, indent=2) + '\n')
    write_combined_dockerfile(context)
    return context, inputs

def docker(*args):
    return subprocess.check_output(['docker', *args], text=True).strip()

def run_build(output, name, args, cwd):
    (output / (name + '-command.json')).write_text(json.dumps(args, indent=2) + '\n')
    logfile = output / (name + '.log')
    attempts = []
    for attempt in (1, 2):
        with logfile.open('w') as log:
            result = subprocess.run(args, cwd=cwd, stdout=log, stderr=subprocess.STDOUT)
        transient = result.returncode != 0 and any(
            line.startswith('ERROR: failed to solve: failed to resolve source metadata for ')
            and any(line.endswith(message) for message in
                    ('connection reset by peer', 'TLS handshake timeout', 'i/o timeout', 'unexpected EOF'))
            for line in logfile.read_text(errors='replace').splitlines())
        attempts.append({'attempt': attempt, 'exitCode': result.returncode,
                         'transientSourceFetchFailure': transient})
        (output / (name + '-attempts.json')).write_text(json.dumps(attempts, indent=2) + '\n')
        if result.returncode == 0:
            return
        if attempt == 1 and transient:
            # Resume the same solve/cache once. Keep first-failure evidence; never hide
            # a second failure or retry compiler, authentication or integrity errors.
            shutil.copyfile(logfile, output / (name + '-attempt-1.log'))
            print(f'{name}: retrying one interrupted source fetch', flush=True)
            continue
        raise RuntimeError(f'{name} failed; see {logfile}')

def source_args(values):
    """Parse NAME=URL overrides of the pinned downloads; checksums and signatures still apply."""
    result = {}
    for value in values:
        name, separator, url = value.partition('=')
        if name not in SOURCE_ARGS or not separator or not re.fullmatch(r'https://[^\s,]+', url):
            raise ValueError('INVALID_SOURCE_ARG:' + name)
        result[name] = url
    return result

def bake_plan(output, tag, revision, entrypoint_sha, no_cache, version, cloud_revision,
              base_revision, cache_repository=None, sources=None):
    """Share a single source graph and cache preparation, not packaging scratch."""
    common = {'CINDY_SOURCE_COMMIT': revision, 'SOURCE_DATE_EPOCH': SOURCE_DATE_EPOCH,
              'CINDY_BASE_SOURCE_COMMIT': base_revision, 'CINDY_UPSTREAM_VERSION': version,
              'CINDY_CLOUD_REVISION': str(cloud_revision), **(sources or {})}
    graph = {'context': '.', 'dockerfile': 'Dockerfile.combined',
             'contexts': {'base-recipe': './base-recipe'},
             'args': {**common, 'CINDY_RUNTIME_VERSION': tag.rsplit(':', 1)[1],
                      'CINDY_ENTRYPOINT_SHA256': entrypoint_sha},
             'platforms': ['linux/amd64'], 'no-cache': no_cache}
    base = {**graph, 'target': 'runtime-base-slim',
            'output': [f'type=docker,name={tag}-base,rewrite-timestamp=false']}
    runtime = {**graph, 'target': 'runtime',
               'output': [f'type=docker,name={tag},rewrite-timestamp=false']}
    records = {**graph, 'target': 'build-records',
               'output': ['type=local,dest=' + str(output / 'records')]}
    targets = {'base': base, 'runtime': runtime, 'records': records}
    if cache_repository:
        refs = registry_cache(cache_repository)
        prepared = {**graph, 'target': 'prepared-native', 'output': ['type=cacheonly']}
        targets['prepared'] = prepared
        targets['materialize'] = {**graph, 'target': 'prepared-materialized',
                                  'output': ['type=cacheonly']}
        # The base max history and prepared min chain describe overlapping
        # ancestors. Importing both can select a different parent and re-run
        # preparation even when the complete prepared result exists remotely.
        # Hydrate only the prepared chain first. Runtime/records then consume
        # that local snapshot; only the base exporter imports its max history.
        for target in targets.values():
            target['cache-from'] = []
        if not no_cache:
            base['cache-from'] = ['type=registry,ref=' + refs['base']]
            prepared['cache-from'] = ['type=registry,ref=' + refs['prepared']]
            targets['materialize']['cache-from'] = list(prepared['cache-from'])
        # Base history rarely changes; preserve its existing max cache. Export
        # only the prepared filesystem chain for the application. Packaging
        # scratch and /layer duplicate the final bytes and are rebuilt per version.
        for name, mode in [('base', 'max'), ('prepared', 'min')]:
            targets[name]['cache-to'] = ['type=registry,ref=' + refs[name]
                + ',mode=' + mode + ',image-manifest=true,oci-mediatypes=true']
    return {'target': targets}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version', required=True, help='upstream application version X.Y.Z')
    parser.add_argument('--cloud-revision', type=int, default=1,
                        help='cloud revision of that version (positive integer, default 1)')
    parser.add_argument('--revision', default='HEAD', help='Git revision of recipe and application (default HEAD)')
    parser.add_argument('--output', required=True, type=Path, help='new directory for context, logs and records')
    parser.add_argument('--tag', required=True, help='new local image tag; not a bare X.Y.Z')
    parser.add_argument('--no-cache', action='store_true')
    parser.add_argument('--prepare-only', action='store_true', help='export the build context only')
    parser.add_argument('--builder', help='existing native amd64 Buildx builder; exports images to local Docker')
    parser.add_argument('--cache-repository', help='dedicated mutable Registry cache repository, requires --builder')
    parser.add_argument('--source-arg', action='append', default=[], metavar='NAME=URL',
                        help='mirror for a pinned download; one of ' + ', '.join(SOURCE_ARGS))
    args = parser.parse_args()
    if not re.fullmatch(VERSION, args.version):
        parser.error('--version must be X.Y.Z')
    if args.cloud_revision < 1:
        parser.error('--cloud-revision must be a positive integer')
    sources = source_args(args.source_arg)
    if args.cache_repository:
        registry_cache(args.cache_repository)
        if not args.builder: parser.error('--cache-repository requires --builder')
    if not re.fullmatch(r'[a-z0-9._/-]+:[a-zA-Z0-9_.-]+', args.tag) or re.search(r':\d+\.\d+\.\d+$', args.tag):
        parser.error('--tag must be name:tag and not a bare X.Y.Z')
    if git('status', '--porcelain', '--', 'deploy/linux-desktop').strip():
        parser.error('commit the recipe before building; tracked and untracked recipe changes are rejected')
    revision = git('rev-parse', '--verify', '--end-of-options', args.revision + '^{commit}').decode().strip()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    context, inputs = prepare(output, revision, args.version, args.cloud_revision)
    (output / 'build-inputs.json').write_text(json.dumps(inputs, indent=2) + '\n')
    if args.prepare_only: return
    base_tag = args.tag + '-base'
    for tag in (args.tag, base_tag):
        if subprocess.run(['docker', 'image', 'inspect', tag], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
            raise ValueError('LOCAL_TAG_EXISTS:' + tag)
    entrypoint_sha = digest((context / 'recipe/runtime-desktop-xfce/cindy-linux-desktop').read_bytes())
    if args.builder:
        plan = output / 'docker-bake.json'
        plan.write_text(json.dumps(bake_plan(output, args.tag, revision, entrypoint_sha, args.no_cache,
            args.version, args.cloud_revision, inputs['baseRecipeCommit'], args.cache_repository, sources), indent=2) + '\n')
        command = ['docker', 'buildx', 'bake', '--builder', args.builder,
                   '--allow=fs.write=' + str(output), '--progress=plain', '-f', str(plan)]
        # Metadata-only cache hits do not restore the prepared filesystem. Mount
        # its chain in a separate network-free solve before parallel exporters;
        # otherwise max/min parent selection can re-execute installation.
        # Explicit cold builds retain no-cache for the entire graph.
        if args.cache_repository and not args.no_cache:
            run_build(output, 'prepare-build', command + ['--metadata-file',
                str(output / 'prepare-metadata.json'), 'prepared'], context)
            run_build(output, 'materialize-build', command + ['--metadata-file',
                str(output / 'materialize-metadata.json'), 'materialize'], context)
        run_build(output, 'full-build', command + ['--metadata-file',
                  str(output / 'build-metadata.json'), 'base', 'runtime', 'records',
                  *(['prepared'] if args.cache_repository and args.no_cache else [])], context)
        base = json.loads(docker('image', 'inspect', base_tag))[0]
        info = json.loads(docker('image', 'inspect', args.tag))[0]
        finish(output, info, base, revision, entrypoint_sha, args.builder)
        return
    build = ['docker', 'buildx', 'build', '--platform', 'linux/amd64', '--progress=plain',
             *(['--no-cache'] if args.no_cache else [])]
    common = ['--build-arg', 'SOURCE_DATE_EPOCH=' + SOURCE_DATE_EPOCH]
    for name, url in sources.items():
        common += ['--build-arg', name + '=' + url]
    run_build(output, 'base-build', build + ['-f', 'runtime-base/Dockerfile', *common,
              '--build-arg', 'CINDY_SOURCE_COMMIT=' + inputs['baseRecipeCommit'],
              '--target', 'runtime-base-slim', '--output', f'type=docker,name={base_tag},rewrite-timestamp=false', '.'], context / 'base-recipe')
    base = json.loads(docker('image', 'inspect', base_tag))[0]
    runtime_args = ['-f', 'recipe/Dockerfile', *common, '--build-arg', 'BASE_IMAGE=' + base_tag,
                    '--build-arg', 'CINDY_SOURCE_COMMIT=' + revision,
                    '--build-arg', 'CINDY_UPSTREAM_VERSION=' + args.version,
                    '--build-arg', 'CINDY_CLOUD_REVISION=' + str(args.cloud_revision),
                    '--build-arg', 'CINDY_RUNTIME_VERSION=' + args.tag.rsplit(':', 1)[1],
                    '--build-arg', 'CINDY_ENTRYPOINT_SHA256=' + entrypoint_sha]
    run_build(output, 'runtime-build', build + runtime_args + ['--target', 'runtime', '--output',
              f'type=docker,name={args.tag},rewrite-timestamp=false', '.'], context)
    if json.loads(docker('image', 'inspect', base_tag))[0]['Id'] != base['Id']:
        raise RuntimeError('BASE_IMAGE_CHANGED')
    info = json.loads(docker('image', 'inspect', args.tag))[0]
    run_build(output, 'build-records', ['docker', 'buildx', 'build', '--platform', 'linux/amd64',
              '--progress=plain', *runtime_args, '--target', 'build-records', '--output',
              'type=local,dest=' + str(output / 'records'), '.'], context)
    finish(output, info, base, revision, entrypoint_sha)

def finish(output, info, base, revision, entrypoint_sha, builder=None):
    """Record both image configs, then audit the runtime image before reporting it."""
    import release_guard
    (output / 'base-image.json').write_text(json.dumps(base, indent=2) + '\n')
    (output / 'runtime-image.json').write_text(json.dumps(info, indent=2) + '\n')
    release_guard.audit_image(info, base, revision, entrypoint_sha)
    result = {'imageId': info['Id'], 'baseImageId': base['Id'], 'sourceCommit': revision, 'bytes': info['Size']}
    if builder: result['builder'] = builder
    (output / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'imageId': info['Id'], 'output': str(output)}))

if __name__ == '__main__':
    main()

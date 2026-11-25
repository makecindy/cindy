"""Checks on the built runtime image config: platform, user, start command, layers, labels."""
ENTRYPOINT = ['/usr/local/bin/cindy-seccomp', '/usr/local/bin/cindy-linux-desktop']
CMD = ['/opt/cindy/Cindy']

class ReleaseRejected(RuntimeError):
    pass

def require(ok, reason):
    if not ok:
        raise ReleaseRejected(reason)

def audit_image(info, base, source_commit, wrapper_sha):
    cfg = info['Config']
    require(info['Os'] == 'linux' and info['Architecture'] == 'amd64', 'IMAGE_PLATFORM')
    require(cfg.get('User') in ['cindy', '10001:10001'], 'IMAGE_USER')
    require(cfg.get('Entrypoint') == ENTRYPOINT and cfg.get('Cmd') == CMD, 'IMAGE_START_COMMAND')
    layers = info['RootFS']['Layers']
    require(len(base['RootFS']['Layers']) == 1 and len(layers) == 2
            and layers[0] == base['RootFS']['Layers'][0], 'IMAGE_LAYER_ACCUMULATION')
    labels = cfg.get('Labels', {})
    require(labels.get('io.cindy.source-commit') == source_commit, 'IMAGE_SOURCE_COMMIT')
    require(labels.get('io.cindy.entrypoint-sha256') == wrapper_sha, 'IMAGE_ENTRYPOINT_LABEL')
    return {'imageId': info['Id'], 'layers': len(layers), 'bytes': info['Size']}

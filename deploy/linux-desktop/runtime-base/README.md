# Dependency base

`Dockerfile` builds the third-party filesystem of the image from pinned inputs: one layer,
no `/opt/cindy`, no Cindy-owned programs.

- `runtime-base-slim` is the base of the application image. It removes `chromium`,
  `chromium-common` and `chromium-sandbox` (Google Chrome remains), checks the remaining
  packages against the lock, clamps timestamps and flattens to one layer.
- `runtime-base` is the full package set in `packages.lock`.

## Pinned inputs

| Input | Pin |
| --- | --- |
| Dockerfile frontend, Node image | Image digests |
| Debian packages | `packages.lock`: every package with version, architecture and manual mark, from two dated snapshot.debian.org archives, verified with the Debian keyring |
| Themes, emoji font, `libturbojpeg0`, `libjson-c5`, locales | Version and SHA-256; only the needed files are copied, the packages are not installed. The remote-desktop native module loads the two libraries |
| Google Chrome, GitHub CLI | Version and SHA-256 |

The `cindy` account (UID/GID 10001, no login shell), the D-Bus machine ID and all
timestamps are fixed, so the layer depends only on these inputs. `zh_CN.UTF-8` is the
default locale.

`NODE_IMAGE`, `DEBIAN_SNAPSHOT_URL`, `CHROME_DEB_URL` and `GH_TARBALL_URL` may name a
mirror of the same artifacts. Google serves only recent Chrome builds, so keep a copy of
the pinned `.deb`.

## Changing packages

Choose new snapshot dates, update the versions in `packages.lock` and rebuild. The build
fails on any missing, extra or different package, version, architecture or mark.
`base_lock.py capture <image-id> <output>` writes a lock from an existing image.

`../build-image.py` builds the base as part of the image and labels it with the last commit
that changed its inputs, so other changes reuse it. To build it alone:

```sh
cd deploy/linux-desktop
docker buildx build --platform linux/amd64 -f runtime-base/Dockerfile \
  --build-arg CINDY_SOURCE_COMMIT="$(git rev-parse HEAD)" \
  --build-arg SOURCE_DATE_EPOCH=1789344000 --target runtime-base-slim \
  --output type=docker,name=cindy-runtime-base:<tag>,rewrite-timestamp=false .
```

```sh
python3 -m unittest discover -s deploy/linux-desktop/runtime-base -p 'test_*.py'
```

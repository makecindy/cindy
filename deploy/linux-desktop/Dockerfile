# syntax=docker/dockerfile:1.10@sha256:865e5dd094beca432e8c0a1d5e1c465db5f998dca4e439981029b3b81fb39ed5
# Context is generated exclusively from Git by build-image.py.
ARG BASE_IMAGE
FROM ${BASE_IMAGE} AS prepared
SHELL ["/bin/bash", "-o", "errexit", "-o", "nounset", "-o", "pipefail", "-c"]
WORKDIR /workspace/source
COPY source/ ./
COPY recipe/download-build-assets.mjs recipe/prepare-codex.mjs recipe/prepare-other-assets.mjs recipe/prepare-linux.sh /workspace/recipe/
ARG CINDY_UPSTREAM_VERSION
ENV CINDY_UPSTREAM_VERSION=${CINDY_UPSTREAM_VERSION} CI=1 NODE_OPTIONS=--max-old-space-size=6144 \
    CINDY_AUTH_REGION=cn VITE_CINDY_AUTH_REGION=cn APP_VERSION=${CINDY_UPSTREAM_VERSION}
# Optional mirror for build-only Debian packages; see prepare-linux.sh.
ARG DEBIAN_BUILD_MIRROR
# Keep Electron ZIP: Forge packager consumes electronZipDir after compilation.
RUN --mount=type=cache,id=cindy-linux-build-assets,target=/var/cache/cindy-build-assets,sharing=locked \
    --mount=type=cache,id=cindy-linux-pnpm-store,target=/var/cache/cindy-pnpm,sharing=locked \
    mkdir -p /workspace/debs /workspace/sysroot \
    && node /workspace/recipe/download-build-assets.mjs \
    && node /workspace/recipe/prepare-codex.mjs \
    && node /workspace/recipe/prepare-other-assets.mjs \
    && pnpm config set store-dir /var/cache/cindy-pnpm --global \
    && ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile \
    && /bin/sh /workspace/recipe/prepare-linux.sh \
    && rm -f /workspace/electron-v42.11.12-headers.tar.gz \
             /workspace/ripgrep-linux-x64.tar.gz /workspace/codex-package-linux-x64.tar.gz /workspace/pi-linux-x64.tar.gz \
    && rm -rf /workspace/debs /var/lib/apt/lists/* /root/.npm/_cacache

# Build only the cloud Dock library; tools remain in a disposable build stage.
FROM prepared AS dock-build-tools
COPY build-recipe/runtime-desktop-xfce/plank/build-deps.txt /workspace/plank-build-deps.txt
RUN apt-get -o Acquire::Retries=5 update \
    && mapfile -t deps < /workspace/plank-build-deps.txt \
    && apt-get -o Acquire::Retries=5 install --yes --no-install-recommends "${deps[@]}"

FROM dock-build-tools AS dock-build
# Either URL may point at a mirror of the same file; the checksums stay pinned.
ARG PLANK_SOURCE_URL=https://snapshot.debian.org/archive/debian/20260905T205002Z/pool/main/p/plank/plank_0.11.89.orig.tar.xz
ARG PLANK_DEBIAN_SOURCE_URL=https://snapshot.debian.org/archive/debian/20260905T205002Z/pool/main/p/plank/plank_0.11.89-4.debian.tar.xz
ADD --checksum=sha256:a662a46eaeffbd40661d1f36abd2589f7a98baef4b918876b872047b7ca59d9d ${PLANK_SOURCE_URL} /workspace/plank-downloads/plank_0.11.89.orig.tar.xz
ADD --checksum=sha256:afb06a37ecabf0f83d9b338cf8848c11834f06a9ab611436f34d049734023b9a ${PLANK_DEBIAN_SOURCE_URL} /workspace/plank-downloads/plank_0.11.89-4.debian.tar.xz
COPY build-recipe/runtime-desktop-xfce/plank/ /workspace/plank-recipe/
COPY recipe/runtime-desktop-xfce/plank/README.md /workspace/plank-recipe/README.md
RUN --network=none bash /workspace/plank-recipe/build.sh /workspace/plank-downloads /workspace/plank-output

FROM prepared AS prepared-native
COPY recipe/prime-native-cache.cjs /workspace/recipe/
RUN node /workspace/recipe/prime-native-cache.cjs /workspace/source /workspace/native-cache 42.11.12
COPY --from=dock-build /workspace/plank-output/ /workspace/plank-runtime/

# A cacheonly solve can resolve remote metadata without restoring its filesystem.
# This unexported, network-free target must mount the prepared snapshot before
# the parallel exporters start; otherwise max/min imports can resolve different
# parent snapshots and unexpectedly execute the installation RUN again.
FROM prepared-native AS prepared-materialized
RUN --network=none test -x /workspace/source/node_modules/electron/dist/electron \
    && test -f /workspace/electron-v42.11.12-linux-x64.zip \
    && test -d /workspace/source/node_modules/.pnpm \
    && test -x /workspace/source/apps/codex-package-bin/linux-x64/bin/codex \
    && head -c 1 /workspace/source/node_modules/electron/dist/electron >/dev/null \
    && head -c 1 /workspace/source/apps/codex-package-bin/linux-x64/bin/codex >/dev/null \
    && test -s /workspace/native-cache/manifest.json \
    && printf 'PREPARED_FILESYSTEM_READY\n'

FROM prepared-native AS build
COPY build-recipe/ /workspace/recipe/
ARG CINDY_CLOUD_REVISION
ENV APP_VERSION=${CINDY_UPSTREAM_VERSION}-cloud.${CINDY_CLOUD_REVISION}
RUN /bin/sh /workspace/recipe/build-runtime.sh
RUN --network=none node /workspace/recipe/verify-native-modules.cjs \
    /workspace/source/node_modules/electron/dist/electron /workspace/artifact/cindy /workspace/artifact/native-modules.json
ARG SOURCE_DATE_EPOCH
RUN cp -a /workspace/plank-runtime /workspace/artifact/plank \
    && python3 /workspace/recipe/assemble-runtime.py /workspace/artifact /layer \
    && python3 -I /workspace/recipe/normalize-timestamps.py /layer \
    && python3 /workspace/recipe/audit-runtime-layer.py /layer > /workspace/artifact/runtime-layer-audit.json

FROM scratch AS build-records
COPY --from=build /workspace/artifact/runtime-layer-audit.json /
COPY --from=build /workspace/artifact/agent-source-proof.json /
COPY --from=build /workspace/artifact/native-modules.json /
COPY --from=build /workspace/recipe/overlay-application.json /
# Commit/evidence changes do not invalidate dependency installation or packaging.
COPY recipe/build-inputs.json /

FROM ${BASE_IMAGE} AS runtime
ARG CINDY_SOURCE_COMMIT
ARG CINDY_UPSTREAM_VERSION
ARG CINDY_ENTRYPOINT_SHA256
ARG CINDY_RUNTIME_VERSION
ARG CINDY_CLOUD_REVISION
COPY --from=build --chown=0:0 /layer/ /
ENV HOME=/home/cindy DISPLAY=:99 XDG_RUNTIME_DIR=/tmp/runtime-cindy
LABEL io.cindy.source-commit=${CINDY_SOURCE_COMMIT} \
      io.cindy.entrypoint-sha256=${CINDY_ENTRYPOINT_SHA256} \
      io.cindy.runtime-version=${CINDY_RUNTIME_VERSION} \
      io.cindy.upstream-version=${CINDY_UPSTREAM_VERSION} io.cindy.cloud-revision=${CINDY_CLOUD_REVISION} \
      org.opencontainers.image.version=${CINDY_UPSTREAM_VERSION}-cloud.${CINDY_CLOUD_REVISION} io.cindy.region=cn \
      io.cindy.target-architecture=amd64
USER cindy
ENTRYPOINT ["/usr/local/bin/cindy-seccomp", "/usr/local/bin/cindy-linux-desktop"]
CMD ["/opt/cindy/Cindy"]

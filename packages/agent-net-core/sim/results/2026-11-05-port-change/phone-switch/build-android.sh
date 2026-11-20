set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >&2
apt-get install -y -qq gcc-aarch64-linux-gnu libc6-dev-arm64-cross >&2
rustup target add aarch64-unknown-linux-gnu >&2
mkdir -p /work && cd /work && tar --no-same-owner -xf /src.tar
cd migrate
export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc
export CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc
export AR_aarch64_unknown_linux_gnu=aarch64-linux-gnu-ar
export RUSTFLAGS="-C target-feature=+crt-static"
cargo build --release --offline --target aarch64-unknown-linux-gnu >&2
file_info=$(head -c 20 target/aarch64-unknown-linux-gnu/release/migrate | od -An -tx1 | head -1)
echo "elf header: $file_info" >&2
cat target/aarch64-unknown-linux-gnu/release/migrate

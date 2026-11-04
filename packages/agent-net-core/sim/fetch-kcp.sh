#!/bin/sh
# 下载固定版本的真实 KCP，只用于 compare 对比。目录已被忽略，不进入仓库和产品。
set -eu
COMMIT=b1a7a2101dcbb96017681a500d6b82bbe5a88766
SHA256_C=8654038a70d1bbe605aa94f066554ffb30bf28580a58769970221de3ba5027f0
SHA256_H=d67a0e67ba5701f1e882894b4415c4d3ad3d7d9f7231dd2ca68c6037c5217933
cd "$(dirname "$0")"
mkdir -p vendor-test-only
base="https://raw.githubusercontent.com/skywind3000/kcp/$COMMIT"
curl -fsS "$base/ikcp.c" -o vendor-test-only/ikcp.c
curl -fsS "$base/ikcp.h" -o vendor-test-only/ikcp.h
printf '%s  vendor-test-only/ikcp.c\n%s  vendor-test-only/ikcp.h\n' "$SHA256_C" "$SHA256_H" | shasum -a 256 -c -

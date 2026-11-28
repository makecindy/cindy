"""Stage the official installer and publish each region's entry points last."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile
from urllib.error import HTTPError
from urllib.request import Request, urlopen

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
PREFIX = "cindy/dependencies/cua-driver"
AGENT = {"User-Agent": "Cindy-CuaDriver-mirror"}


def fetch(url):
    return urlopen(Request(url, headers=AGENT), timeout=120)


def read(url):
    with fetch(url) as response:
        return response.read()


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def stage(repo, version, dest):
    tag = f"cua-driver-rs-v{version}"
    release = json.loads(read(f"https://api.github.com/repos/{repo}/releases/tags/{tag}"))
    if release["tag_name"] != tag or release["draft"]:
        raise ValueError("Expected a published exact release")
    assets = {item["name"]: item for item in release["assets"]}
    platforms = ["darwin-universal.tar.gz", "linux-x86_64-binary.tar.gz", "linux-arm64-binary.tar.gz",
                 "windows-x86_64.zip", "windows-arm64.zip"]
    archives = [f"cua-driver-rs-{version}-{platform}" for platform in platforms]
    signed = archives + ["install.sh", "_install-rust.sh", "install.ps1", "SHA256SUMS"]
    for name in signed + [n + ".sigstore.json" for n in signed] + ["checksums.txt"]:
        asset = assets[name]
        expected_url = f"https://github.com/{repo}/releases/download/{tag}/{name}"
        if asset["browser_download_url"] != expected_url or not re.fullmatch(r"sha256:[0-9a-f]{64}", asset["digest"]):
            raise ValueError(f"Invalid release metadata for {name}")
        path = dest / name
        with fetch(expected_url) as response, path.open("wb") as output:
            shutil.copyfileobj(response, output)
        if path.stat().st_size != asset["size"] or "sha256:" + sha256(path) != asset["digest"]:
            raise ValueError(f"Release digest mismatch: {name}")

    checksums = {}
    for line in (dest / "SHA256SUMS").read_text().splitlines():
        if line.strip():
            digest, filename = line.split()
            checksums[filename.lstrip("*")] = digest
    for name in archives + ["install.sh", "_install-rust.sh", "install.ps1"]:
        if sha256(dest / name) != checksums[name]:
            raise ValueError(f"Archive checksum mismatch: {name}")

    commit = json.loads(read(f"https://api.github.com/repos/{repo}/commits/{tag}"))["sha"]
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("Invalid upstream commit")
    for name, path in {
        "_install-common.sh": "libs/cua-driver/scripts/_install-common.sh",
        "_install-common.psm1": "libs/cua-driver/scripts/_install-common.psm1",
        "LICENSE.md": "LICENSE.md",
        "THIRD_PARTY_NOTICES.md": "libs/cua-driver/rust/THIRD_PARTY_NOTICES.md",
    }.items():
        (dest / name).write_bytes(read(f"https://raw.githubusercontent.com/{repo}/{commit}/{path}"))
    return tag


def entry_points(repo, version, base):
    scripts = {}
    for name in ("install.sh", "install.ps1"):
        template = (HERE / name).read_text()
        scripts[name] = template.replace("@BASE@", base).replace("@VERSION@", version).replace("@SOURCE@", repo).encode()
    return {**scripts, "published-version": (version + "\n").encode()}


def cache_directives(response):
    return {item.strip().lower() for item in response.headers.get("Cache-Control", "").split(",")}


def entries_match(base, entries):
    for name, expected in entries.items():
        try:
            with fetch(f"{base}/{name}") as response:
                if response.read() != expected or "no-cache" not in cache_directives(response):
                    return False
        except HTTPError as error:
            if error.code == 404:
                return False
            raise
    return True


def publish(bucket, base, tag, dest):
    import oss2
    for path in sorted(dest.iterdir()):
        relative = f"releases/download/{tag}/{path.name}"
        digest = sha256(path)
        headers = {"x-oss-forbid-overwrite": "true", "Cache-Control": "public, max-age=31536000, immutable",
                   "x-oss-meta-sha256": digest}
        try:
            with path.open("rb") as stream:
                bucket.put_object(f"{PREFIX}/{relative}", stream, headers=headers)
        except oss2.exceptions.ServerError as error:
            if error.code != "FileAlreadyExists":
                raise
        # Verify bytes from the public route, including when a retry found an
        # existing immutable object. A CDN need not forward OSS custom metadata.
        with fetch(f"{base}/{relative}") as response:
            if not {"immutable", "max-age=31536000"} <= cache_directives(response):
                raise ValueError(f"Published cache policy mismatch: {relative}")
            if hashlib.file_digest(response, "sha256").hexdigest() != digest:
                raise ValueError(f"Published asset conflict: {relative}")


def main():
    repo = os.environ.get("CUA_SOURCE_REPOSITORY") or "trycua/cua"
    if not re.fullmatch(r"[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+", repo):
        raise ValueError("Invalid source repository")
    version = read(f"https://raw.githubusercontent.com/{repo}/main/.github/release-state/cua-driver-rs-published-version").decode().strip()
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
        raise ValueError("Invalid published version")
    targets = {}
    for area, manifest in [("CN", "endpoint.json"), ("GLOBAL", "endpoint.global.json")]:
        cdn = json.loads((ROOT / "config" / manifest).read_text())["cdnBaseUrl"].rstrip("/")
        targets[area] = f"{cdn}/dependencies/cua-driver"
    if os.environ.get("GITHUB_EVENT_NAME") == "schedule":
        if all(entries_match(base, entry_points(repo, version, base)) for base in targets.values()):
            print(f"Both regions already serve {repo} {version}")
            return
    with tempfile.TemporaryDirectory() as tmp:
        dest = Path(tmp)
        tag = stage(repo, version, dest)
        print(f"Verified {len(list(dest.iterdir()))} files from {repo} {tag}", flush=True)
        if sys.argv[1:] == ["--verify-only"]:
            return
        import oss2
        env = os.environ
        auth = oss2.StsAuth(env["KEY_ID"], env["KEY_SECRET"], env["TOKEN"], auth_version=oss2.AUTH_VERSION_4)
        buckets = {}
        for area, base in targets.items():
            region = env[f"{area}_REGION"]
            buckets[area] = oss2.Bucket(auth, f"https://oss-{region}.aliyuncs.com", env[f"{area}_BUCKET"], region=region)
            publish(buckets[area], base, tag, dest)
        for area, base in targets.items():
            headers = {"Cache-Control": "no-cache", "Content-Type": "text/plain; charset=utf-8", "x-oss-meta-source": repo}
            entries = entry_points(repo, version, base)
            for name, body in entries.items():
                buckets[area].put_object(f"{PREFIX}/{name}", body, headers=headers)
            if not entries_match(base, entries):
                raise ValueError(f"Public entry point mismatch: {area}")
            print(f"{area}: published {base}/published-version", flush=True)
        if "GITHUB_OUTPUT" in env:
            with open(env["GITHUB_OUTPUT"], "a") as output:
                print(f"version={version}", file=output)


if __name__ == "__main__":
    main()

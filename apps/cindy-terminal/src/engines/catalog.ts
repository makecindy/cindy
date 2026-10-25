// Generated from the repository runtime pins; do not include npm account metadata.
import type { EngineRelease, EngineKind } from './types.js';

export const BUNDLED_ENGINES: Record<EngineKind, EngineRelease> = {
  "claude-code": {
    "version": "2.1.296",
    "assets": {
      "darwin-arm64": {
        "url": "https://downloads.claude.ai/claude-code-releases/2.1.296/darwin-arm64/claude",
        "sha256": "c9b5341637becbd423ddffc5b254afb645682a3868cb708bbc6cc0e7bb419937",
        "size": 240664432,
        "format": "raw",
        "entrypoint": "claude"
      },
      "darwin-x64": {
        "url": "https://downloads.claude.ai/claude-code-releases/2.1.296/darwin-x64/claude",
        "sha256": "a6bf4f30be241053a923f3820ad23c5991d2f5ac2935b3a8dd64da218d9cc603",
        "size": 249194752,
        "format": "raw",
        "entrypoint": "claude"
      },
      "linux-x64": {
        "url": "https://downloads.claude.ai/claude-code-releases/2.1.296/linux-x64/claude",
        "sha256": "24972e3bc859fab2b46ed4c1e51f7d6130f06d3bd550811a114640de3370d0de",
        "size": 257068216,
        "format": "raw",
        "entrypoint": "claude"
      },
      "linux-arm64": {
        "url": "https://downloads.claude.ai/claude-code-releases/2.1.296/linux-arm64/claude",
        "sha256": "f1f6e96e0d8342b9dbf41d7e88255397a6a52ce3d8736ad6a4c6b59c9b62fefa",
        "size": 256434168,
        "format": "raw",
        "entrypoint": "claude"
      },
      "win32-x64": {
        "url": "https://downloads.claude.ai/claude-code-releases/2.1.296/win32-x64/claude.exe",
        "sha256": "76de74f7694a5bdc03378a5f837c9e132827bf004c98c276bc4e9094ff06769a",
        "size": 260489376,
        "format": "raw",
        "entrypoint": "claude.exe"
      }
    }
  },
  "codex": {
    "version": "0.159.2",
    "assets": {
      "darwin-arm64": {
        "url": "https://github.com/openai/codex/releases/download/rust-v0.159.2/codex-package-aarch64-apple-darwin.tar.gz",
        "sha256": "38aaf6dce63099fd10988948d03bbc6c0474253aef6961fcbe60f8d154b39101",
        "size": 129522674,
        "target": "aarch64-apple-darwin",
        "entrypoint": "bin/codex",
        "format": "tar.gz"
      },
      "darwin-x64": {
        "url": "https://github.com/openai/codex/releases/download/rust-v0.159.2/codex-package-x86_64-apple-darwin.tar.gz",
        "sha256": "6b9b38bfad6ac8019aa6a243ee3ab11d3e22889eafd5458b0344cf20e797e680",
        "size": 140813958,
        "target": "x86_64-apple-darwin",
        "entrypoint": "bin/codex",
        "format": "tar.gz"
      },
      "linux-x64": {
        "url": "https://github.com/openai/codex/releases/download/rust-v0.159.2/codex-package-x86_64-unknown-linux-musl.tar.gz",
        "sha256": "9e2d29a713b94478b240dec2f10e11324cd05fad76dc43e7c639bdf8a1337a6b",
        "size": 159961162,
        "target": "x86_64-unknown-linux-musl",
        "entrypoint": "bin/codex",
        "format": "tar.gz"
      },
      "linux-arm64": {
        "url": "https://github.com/openai/codex/releases/download/rust-v0.159.2/codex-package-aarch64-unknown-linux-musl.tar.gz",
        "sha256": "05a524a463cadf7e3e22c7f923539c0d0b74c3e78b1f5f1fab52e50e6fb3312f",
        "size": 150270060,
        "target": "aarch64-unknown-linux-musl",
        "entrypoint": "bin/codex",
        "format": "tar.gz"
      },
      "win32-x64": {
        "url": "https://github.com/openai/codex/releases/download/rust-v0.159.2/codex-package-x86_64-pc-windows-msvc.tar.gz",
        "sha256": "a7ab591043d99e8a88d0c2bebf15f810b15599a71148c4af944a755af3c71eef",
        "size": 156614559,
        "target": "x86_64-pc-windows-msvc",
        "entrypoint": "bin/codex.exe",
        "format": "tar.gz"
      },
      "win32-arm64": {
        "url": "https://github.com/openai/codex/releases/download/rust-v0.159.2/codex-package-aarch64-pc-windows-msvc.tar.gz",
        "sha256": "f017342f77ec57dffff57e59723738ac9f228ddab4f656c2bdfc65f1d9b87da3",
        "size": 144725539,
        "target": "aarch64-pc-windows-msvc",
        "entrypoint": "bin/codex.exe",
        "format": "tar.gz"
      }
    }
  },
  "pi": {
    "version": "1.0.2",
    "assets": {
      "darwin-arm64": {
        "url": "https://github.com/earendil-works/pi/releases/download/v1.0.2/pi-darwin-arm64.tar.gz",
        "sha256": "c2f035ea4adba87916f005c99515e3c91674b11d16ba75d95d0881e4781aa3bb",
        "size": 31007294,
        "format": "tar.gz",
        "entrypoint": "pi"
      },
      "darwin-x64": {
        "url": "https://github.com/earendil-works/pi/releases/download/v1.0.2/pi-darwin-x64.tar.gz",
        "sha256": "d54be8df33ab6a2f3457bd7de37edc947050ac4a7f043456d37e03afd15684de",
        "size": 33468700,
        "format": "tar.gz",
        "entrypoint": "pi"
      },
      "linux-x64": {
        "url": "https://github.com/earendil-works/pi/releases/download/v1.0.2/pi-linux-x64.tar.gz",
        "sha256": "0d7687a6a9fcbaa88ff664cb6b28683ce9ee3e028931b55eb48a70ae9a285d18",
        "size": 42560818,
        "format": "tar.gz",
        "entrypoint": "pi"
      },
      "linux-arm64": {
        "url": "https://github.com/earendil-works/pi/releases/download/v1.0.2/pi-linux-arm64.tar.gz",
        "sha256": "3321ccdc3ff38d6c52274bdab28246e06434618d1988a54e99cce45e535a013c",
        "size": 42656944,
        "format": "tar.gz",
        "entrypoint": "pi"
      },
      "win32-x64": {
        "url": "https://github.com/earendil-works/pi/releases/download/v1.0.2/pi-windows-x64.zip",
        "sha256": "37a2ee3c5222a73efc78b49f571748f11a74f4dbe160da3030a404da71f464e7",
        "size": 45048394,
        "format": "zip",
        "entrypoint": "pi.exe"
      },
      "win32-arm64": {
        "url": "https://github.com/earendil-works/pi/releases/download/v1.0.2/pi-windows-arm64.zip",
        "sha256": "4eb7c89f12c523d28069fed66f2ceb2466f909e41c87a6367a52728cec938b15",
        "size": 43683455,
        "format": "zip",
        "entrypoint": "pi.exe"
      }
    }
  }
};

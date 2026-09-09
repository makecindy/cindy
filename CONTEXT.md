# Local Harness Integration

This context defines Cindy's language for connecting locally installed agent
CLIs whose authentication and model routing remain owned by the CLI vendor.

## Language

**Harness**: An agent loop that owns native sessions, tool execution, and its
own upstream protocol. A Harness is not a model provider.
_Avoid_: Model, provider, CLI

**Runtime distribution**: The concrete executable distribution used by an
existing Harness adapter, such as Cindy-managed Claude Code or local
Tencent-wrapped Claude Code.
_Avoid_: Harness, provider

**Harness-managed route**: A session route where the selected local Harness
owns model authentication and upstream routing, while Cindy owns the product
session and interaction surfaces.
_Avoid_: BYOK route, proxy route

**Capability profile**: A persisted, probe-derived record of the precise
runtime capabilities that Cindy may enable for one executable identity.
_Avoid_: Version compatibility, assumed support

**Candidate feature**: A proposed Harness capability tracked with a support
state before it is exposed to users.
_Avoid_: Supported feature, roadmap item

**Safe fallback**: A deliberately reduced behavior for an older or incapable
client that preserves readable task state without granting unsupported control.
_Avoid_: Compatibility, silent fallback

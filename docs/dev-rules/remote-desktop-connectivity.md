# Remote desktop connectivity

DeviceLink WSS remains the authorized signaling/control transport. WebRTC media
and its input channel use ICE, with the existing JPEG path retained when video
cannot connect. File transfer reuses the ICE configuration through an independent
data-only connection; object storage remains its fallback (see below).

## ICE configuration

Each viewer attempt requests `GET /api/device-link/ice-servers` from its authenticated
device-link service. The controlled Desktop independently requests that same API
while preparing its capture window. API credentials stay in Main / native Mobile;
only short-term TURN allocation credentials cross the dedicated capture/WebView
bridge. These scoped WebRTC credentials cannot authorize desktop input or invoke
business APIs. They are never embedded in static HTML, persisted or logged.

Response: `{iceServers: [{urls: string[], username: string, credential: string}],
expiresAt: string | null}`. At most four entries and four STUN/TURN URLs per entry;
URL scheme/length/ports and credential lifetime are checked before bridge delivery.
Require two minutes of remaining lifetime for cold capture/SDP/ICE headroom.
The owning backend supplies its deployment's node pool; no new user region setting.

Missing endpoint, empty configuration, invalid response and a three-second timeout
fall back to the old public STUN list. With a valid self-hosted list, public STUN
is not added. All configured nodes participate in ICE checks; a dead first node
does not prevent using candidates from the others. URI ordering is not a promise
of priority. Candidate statistics already distinguish direct, relay and JPEG paths.

Every existing bounded media retry fetches fresh configuration on both peers.
No configuration cache, WSS reconnect or new global retry loop. The WebView bounds
its native bridge wait at 3.5 seconds. Lease/generation/attempt checks reject stale
responses; explicit stop takes precedence. A failed media attempt affects only its
owner. Credential expiry may require rebuilding the connection; this change does
not promise uninterrupted in-place renewal of TURN allocations.

Old clients continue unchanged. New viewer + old Desktop can still use viewer-side
TURN; old viewer + new Desktop can use host-side TURN. Existing full-SDP and trickle
ICE capabilities stay unchanged. The desktop-video connectivity change adds no new wire kinds or native dependencies.
The independent file transport below has its own authorized IPC channel.

## Verification

Unit tests cover invalid/expired tickets, old/disabled backends, bounded requests,
fresh credentials/backup lists on retries, and stop/late-response isolation.
The Server repository contains the coturn deployment template and matching API
contract (`docs/device-link-server.md`, `infra/turn/README.md`).

For a real relay test, store an authenticated API response in a task-specific
temporary directory outside this repository (mode 0600), then run:

```sh
node scripts/remote-desktop-turn-smoke.mjs /absolute/external/ice-config.json /absolute/path/to/chrome
```

The probe uses an isolated sandboxed browser, forces relay on both peers, checks
16 KiB data round-trip and the selected relay pair for each TURN URL, then repeats
with an unreachable first node. Output excludes URLs, IPs, credentials and SDP.
Delete the temporary credential file after use. This operator probe makes real
network requests and is intentionally excluded from unit tests.

Local test evidence for this change: coturn 4.18.0, two loopback nodes, real Chrome,
UDP/TCP for both nodes and unreachable-primary case passed. Separately, coturn's
client verified a temporary test CA and received 40 TLS-relayed messages using the
deployment template with loopback-only test overrides. This proves TURN data flow
with the Server credential algorithm; it does not prove platform UI behavior,
publicly trusted browser TLS, the Linux container deployment, or Mainland China reachability.
For rollout, repeat on the deployed nodes and real Desktop/Mobile with trusted TLS,
node failure, >1-hour sessions, two viewers and network switching. Compare STUN-only
versus configured TURN on identical network pairs, recording sample count,
connection success, first moving frame time, selected path, RTT and recovery time.

## QA handoff

Before external QA, deploy the matching ICE API to the test environment and inject
its TURN node configuration through deployment secrets. Distribute Desktop and
Mobile builds from this change that use that environment. Both devices must use
the same account/session realm. A loopback proxy or an inspector-only endpoint
override on a developer machine is not a usable QA environment. Keep login realm
discovery intact; Desktop local-server mode pins both realms to the local manifest
and is unsuitable for testing production enterprise SSO across realms.

On 2026-09-09, a macOS Desktop and an iOS simulator on the same machine displayed
real desktop video and delivered a pointer movement to the expected OS position.
With a separately hosted public coturn node, forced UDP relay and TCP relay with
an unreachable first candidate server connected. Closing an established media
connection recovered via UDP relay in approximately 16 seconds. The deployed ACL
was corrected to omit `denied-peer-ip=::`, which coturn interprets as an unbounded
range; coturn already rejects unspecified peers before its ACL checks.

These are functional probes, not a network-quality acceptance result. A direct
sample had 1 ms RTT and a UDP-relay sample had 84 ms RTT; neither is an average or
end-to-end input latency. Receiver loss and jitter were not collected. Publicly
trusted TLS, Linux Compose, physical phones, Windows/Android, concurrent viewers,
active-node failover, and hour-long sessions still need QA coverage.

For each network pair, record client versions, session realm, transport, attempts,
successes, first moving frame time, RTT p50/p95, receiver packet-loss deltas, jitter,
frame rate/freezes and recovery duration. Distinguish connection recovery from
initial selection of a reachable backup, and RTT from input-to-visible-response
latency. Test the previous STUN-only behavior on the same pairs. Include JPEG and
object-storage transfer regression checks; do not report unavailable metrics as zero.

## Remote files and HTML snapshots

`device-link:file-peer` is an allowlisted DeviceLink RPC, with a 30-second request
budget and versioned `caps`, `offer`, `open`, `close` actions. Signaling keeps the
existing account, enabled-host and controller-revocation checks. It introduces no
relay envelope kind or server file API. Both peers use the existing ICE endpoint;
ICE chooses a direct or TURN path. The file channel does not share desktop video,
input handling, capture permissions or capture-process lifetime.

Desktop images, file-browser reads and HTML snapshot downloads attempt this path
before the existing OSS transfer. Mobile uses a separate trusted WebView with a
build-time-generated script (`node scripts/file-peer-runtime.mjs`), never native
`Function.toString()`. User HTML receives no native file or transport bridge.
Missing peer capability, connection or transfer failure falls back to OSS; explicit
cancellation/account change cancels the operation instead. Old hosts remain usable
through OSS, but the direct file path requires an updated host.

An `open` request resolves the same authorized media URL as OSS. Only Main resolves
paths, checks the effective size limit and opens the descriptor. The renderer sees
an opaque one-use ticket. Files are limited to 100 MiB, transferred in 16 KiB blocks
with at most 16 outstanding blocks, and checked for exact size, offsets and source
stat changes through EOF. This is not a persistent content-hash cache. Changed files
fail and follow the existing fallback behavior. Each source and sink rechecks its
connection owner; revoking one controller closes only that controller's transfers.
Connections are bounded, reusable for sequential files and expire after 30 seconds
idle. Mobile staging has a 256 MiB aggregate cap and a five-minute lifetime; consumers
copy into their existing cache/preview ownership. Backgrounding cancels in-flight
work, but completed files retain their normal lifetime. Account changes remove them.

The HTML strategy remains a directory snapshot served by a viewer-local loopback
HTTP server. Direct/TURN changes how the bytes arrive, not how relative navigation,
CSS, JavaScript or images resolve. It does not execute a remote site's backend.
The Mobile loopback server is a native-module change and requires a compatible
native build; the WebRTC transport itself reuses the existing WebView dependency.

Validation entrypoints: `node scripts/file-peer-smoke.mjs <Chrome executable>`
checks the shipped WebView script over a real local WebRTC connection, including
empty/block-boundary files, sequential reuse and sink failures. Protocol, Main
permission/descriptor and Mobile staging tests cover bounded failure paths. This
local browser probe does not establish deployed TURN, physical phone, network
switching or release-build acceptance; test those separately with matching accounts
and record versions and the actual selected path.

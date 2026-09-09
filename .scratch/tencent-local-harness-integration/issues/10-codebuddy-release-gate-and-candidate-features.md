# 10: Close CodeBuddy release gates and publish candidate feature states

**What to build:** The CodeBuddy delivery has a verifiable release boundary:
real ACP smoke, protocol diagnostics, process cleanup, and cross-device safe
fallback are complete. Candidate features are explicitly represented as MVP,
probe-gated, upstream dependency, deferred, or unsupported so users are not
shown unverified capabilities.

**Blocked by:** 08: Expose CodeBuddy as a Desktop Tencent source; 09: Deliver CodeBuddy cross-device safe fallback.

**Status:** ready-for-agent

- [ ] Real ACP smoke covers the user-visible CodeBuddy MVP in a temporary
      workspace without reading or emitting credentials.
- [ ] Resume stdout filtering records diagnostics and rejects unknown protocol
      contamination.
- [ ] CodeBuddy process shutdown, crash handling, and pending interaction
      settlement are verified.
- [ ] Candidate feature states are visible to the runtime and UI so unavailable
      capabilities are not presented as supported.
- [ ] The release decision documents any remaining upstream dependency and
      leaves deferred features unavailable by default.

# Device Link background connections

`background-link-v1` is declared in both `link-open` and `link-accept`. A controller
declares it only when it has no `session:<id>` or legacy `*` subscription for the peer.
`sessions`, `fs-watch:*`, capability probes, bootstrap reads and other passive operations
remain background work; they must not display the remote-control banner or block unattended
updates on a capable peer.

An older peer that omits the capability may install its legacy wildcard subscription. A
background operation must close that link and treat the incompatibility as permanent: it must
skip the remaining bootstrap and periodic passive reads until the peer's version or capabilities
change. A foreground session, explicit open, invoke, or desktop viewer may keep a shared link
open; when its final hold is released, the incompatible legacy link is cleaned up.

The capability is additive: older Desktop and Mobile clients keep their existing behavior. It
does not add a relay channel or change the wire format beyond the declared capability.

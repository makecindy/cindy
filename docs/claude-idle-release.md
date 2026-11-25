# Ordinary Claude task idle release

Desktop releases ordinary local Claude Code runtimes after 30 minutes without
activity, checked once per minute. Tasks, history and workspace remain available;
the next message uses the existing lazy-create/resume path. Reopening Desktop or
re-enabling this setting starts a fresh observation period.

The advanced file override is `<userData>/claude-idle-release.json`:

```json
{ "minutes": 30 }
```

`minutes` is an integer from 0 to 1440; 0 disables reclamation. Missing or invalid
values use 30. The small file is read at scan and close boundaries; no restart is
needed, including edits that retain its timestamp and size. Only store
an explicit override; deleting the key/file restores the current default. New and
existing users without an override follow that default. Thirty minutes avoids
retaining completed tasks overnight while allowing pauses between messages.

Running turns, queued/recovering input, pending interactions (including async
questions and answers in flight), background tasks and wake continuations prevent
release. Session's atomic idle-close also protects unfinished terminal delivery
and host operations such as manual compact, rewind and model changes.
Release also requires the live native session
identity to match its persisted resume identity. Missing runtime/task facts postpone
release.
Orca workers/active leads, bots, unfinished Goals, hidden tasks, non-Desktop
sources, tasks executed on another computer and SSH runtimes retain their existing
lifecycle. Mobile/device-link controllers of an
eligible Desktop task share its normal resume path; no new wire API is introduced.
For SSH channel diagnostics (pairing local open/close logs with remote bridge
processes), Claude Code manager bridges and Codex proxies carry an anonymous id
in the remote process environment (`CINDY_SSH_CHANNEL_ID`, see
`maker-host/sshChannelTrace.ts`).

Codex and plugin engine (ACP) tasks use the same watcher, scope and gates with a
fixed 30 minutes and no override; both also wait for `hasLiveBackgroundWork` to
report no provider work. A plugin engine task holds one engine process (a few hundred
MB each); without release every task ever opened kept its process. Plugins once had a
fixed 8-process cap, so idle tasks also blocked new ones from starting (2026-11-25);
#12798 removed that cap, so release is now what keeps idle processes from piling up.
A plugin engine runtime is released only when its agent advertised `session/resume` or
`session/load` (`Session.canResumeAfterClose`); resuming never falls back to a new
session, so other runtimes keep their process. Plugin engine Orca workers follow the
collaboration Worker idle setting like any Worker. The Node Host does not run plugin
engines and has no plugin engine watcher.

Implementation: `apps/desktop/src/main/maker-ipc/claudeIdleReleaseWatcher.ts`.

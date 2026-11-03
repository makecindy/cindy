# Computer Use observations

Discover only the schemas needed for the next operation, for example
`list_tools({"names":["list_windows","get_window_state","click"]})`.
An empty argument object still returns the complete catalogue. MCP argument
objects are not CLI flags; `list_apps` accepts no `running_only` filter.

After selecting the actual `pid` and `window_id`, read the window once. A
subsequent action can request the next usable observation in the same call:

```json
{
  "name": "click",
  "args": {
    "pid": 123,
    "window_id": 456,
    "element_token": "<token from the latest observation>",
    "observe": {}
  }
}
```

`observe: {}` returns text; `observe: {"include_screenshot": true}` requests
visual evidence through the normal host screenshot path. Omitted `query`,
`max_elements` and `max_depth` inherit the latest successful observation of
that session/window. Override them only when the target is outside the current
scope. The returned `observation` uses the ordinary read result envelope and
registers fresh element tokens and secure-field frames. It is mutually exclusive
with `postcondition`, which checks an explicit assertion instead.
Invalidating element references does not discard that scope: automatic evidence,
failed reads and failed verification keep the last successful explicit read's
bounds, while old tokens remain stale. A successful later read replaces the scope.

Delivery and observation have separate outcomes: inspect `observation.ok` and
the returned state before continuing. Failed reads do not undo delivery, and
unknown delivery is not proof that the goal succeeded. Input is never replayed
automatically. Refused actions do not trigger the optional observation.
An action exception marked `outcomeUnknown` also honors `observe`, preserving
its error code and partial-input progress alongside the new observation. A failed
observation does not replace the original action error. Cancelled actions and
unresolved window identities do not trigger this follow-up read.

Cindy MCP supplies the task's stable driver session and is the only desktop
input entry. The native `cua-driver` CLI/MCP, `osascript` keystrokes, `cliclick`,
CGEvent scripts and clipboard paste are not alternatives: they skip the session,
the secure-field refusal, remote-input and user-activity yield and result
verification. Cindy keeps them out of reach: the user's own `cua-driver` / `cua`
MCP registrations are always denied for Claude Code (`maker-host/capability-routing.ts`;
Cindy's Computer Use setting is the one switch for driving this desktop, and a
raw driver server would bypass it exactly when it is off), shell-synthesized
input is denied by a Claude PreToolUse guard (local runtimes only; full-access
included) and, under Ask / Auto, by the shared reviewer policy for the computer
running Cindy (`maker-core/agents/shared/desktop-input-shell.ts`,
`continuation-policy.ts`). Codex full access has no host interception point and
Pi full access is left native. A refusal is a result to report. Reuse discovered process/window identities; do not guess bundle IDs.
Foreground input already activates its target, so a preceding `bring_to_front`
is usually redundant.

## Routing facts from the 2026-10 audit

- `USER_INPUT_ACTIVE`: foreground delivery is refused while system input newer
  than the Agent's own last dispatch is under three seconds old
  (`powerMonitor.getSystemIdleTime`, whole seconds). Background delivery and
  `set_value` are unaffected.
- `HOTKEY_BLOCKED`: lock-screen, log-out and sleep chords never reach the driver.
- `CUA_UNAVAILABLE` carries `reason`: `screen_locked` (host power monitor),
  `window_gone` / `window_not_on_screen` (from recovery discovery) or
  `driver_error`. Recovery discovery is compacted to window identity fields.
- `list_windows` identities add `ios-simulator` (Simulator.app, Device Hub) with a
  hint that synthetic input is not delivered there, and a `set_value` hint for
  Electron / browser targets. `set_value` was verified on Cindy's own composer:
  the field updates and its send button enables, without focus.

## CUA 0.37 compatibility

On 2026-10-22, a read-only native check reproduced `typed_output_mismatch`
(`returned_element_count does not match elements`) with `tree_format: "both"`
and `since: "latest"`. Full actionable observations therefore keep structured
elements and do not request a diff. Automatic evidence, which cannot supply
tokens for later actions, uses Markdown diffs with the previous traversal scope.
The adapter drops `since` for older drivers that do not advertise it. The
permission-switch locator also discovers the installed schema once per connection
and explicitly requests structured elements when supported.

## Validation and cost, 2026-10-22

Measured through the production MCP server and an in-memory driver, against
base `0a9987b416`:

| Measurement | Before | After |
| --- | ---: | ---: |
| Advertised MCP catalogue, JSON bytes | 1,540 | 2,023 |
| Complete discovery response, UTF-8 bytes | 42,269 | 50,028 |
| Discovery for `click` alone, UTF-8 bytes | 42,269 (full list required) | 5,455 |
| Driver calls after an initial read, for unknown click delivery followed by a usable read | 3 | 2 |
| Model tool calls for that action and usable read | 2 | 1 |

The full response grows because actions advertise the optional observation
schema; focused discovery is about 87% smaller than the previous full response.
Repeated MCP catalogues were byte-identical within each version. Tool names,
system-prompt assembly and usage accounting are unchanged; this is not a
measurement of vendor cache-hit rates or live model latency.

Regression coverage runs through real MCP dispatch for token freshness, session
and scope retention, separate action/read outcomes, refusal and password-field
protection. Desktop tests exercise schema adaptation and the switch locator with
both older and modern driver contracts. GUI mutations use mock drivers in these
tests; the native compatibility check above only read a window.

A separate native macOS benchmark used the production MCP server and actual
CUA 0.37.0 against a dedicated AppKit window with 80 static rows. Each click
incremented a counter, verified through the next AX observation. Twelve
alternating before/after pairs per mode produced 48 measured actions, plus
eight excluded warmups; all 56 postconditions passed.

| Median per action and usable observation | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| Text observation | 782.5 ms | 713.6 ms | 8.8% |
| Screenshot observation | 882.1 ms | 774.0 ms | 12.3% |
| Text response JSON | 11,591 B | 6,076 B | 47.6% |
| Screenshot response JSON | 12,007 B | 6,492 B | 45.9% |

Both versions used the same driver, window and traversal bounds (200 nodes,
depth 15). Timing starts after the initial observation and ends with the next
usable snapshot. Actual clicks returned `unverifiable`, so the old path made
three driver calls and the new path made two. This measures the production MCP
server and native driver, not the full Electron host or model/network latency.
PNG bytes are excluded from JSON sizes. The small controlled sample does not
establish an improvement in complex-task success rates or overall token costs.

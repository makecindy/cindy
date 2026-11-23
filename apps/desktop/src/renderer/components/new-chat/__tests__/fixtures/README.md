# L342 protocol fixture

`l342SignedCompatibility.test.tsx` runs the production `ChatInput` and
`makerTransport` against frozen older receivers and the current Host. A
three-argument deferred acknowledgement must still send the two legacy axis
writes. A CAS payload carries both axes and must apply them exactly once.

The archived receivers contain the published capabilities, session-selection,
model, effort and Fast handlers, credential mode decision and remote settings
write-back from these releases. The generated files are byte-for-byte copies
of the review fixtures.

| Release commit | Fixture SHA-256 |
| --- | --- |
| v0.1.25 `ba8258beb2ba403a88cd288a0f1abb8505be89bc` | `6221e088d55a4440444a19325513b66a50212fa9ea5c6b8430bac2f3e19b457c` |
| v0.1.26 `6ef0db1d0b97ab6431cc453cc704c8c2ffdf5fee` | `13598db5fdcabfb71546977901531cfd305f9855131390797d1f6675d133fd12` |

The fixture supplies the IPC bridge, busy Codex session, catalog and real
in-memory SQLite storage around the released handlers. The current Host runs
its service routes, Device Link invocation context, input queue and settings
registry in a child process with a temporary profile and a migrated database.
The UI test drives its registered model and provider callbacks using simulated
Device Link frames and accounts. It resides in the Desktop integration tier
because the current Host uses its frozen dependencies and SQLite extension.

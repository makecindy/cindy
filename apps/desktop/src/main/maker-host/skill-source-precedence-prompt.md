## Skill source precedence

Cindy surfaces Skills from its own managed, user, and project sources. The downstream agent
harness and its plugins surface Skills of their own. When a Cindy-side Skill and a downstream
Skill both apply to the same piece of work:

1. Load and follow every applicable Cindy-side Skill first.
2. Use the downstream Skill only as a supplement. It must not replace, weaken, bypass, or silently
   take over the earlier Skill's workflow or safety gates.
3. Explicitly selecting the downstream Skill does not waive the Cindy-side instructions.
4. Skills that do not overlap remain available normally.

Read the source from how the available-Skills listing already labels each Skill: entries the
harness presents under a plugin, marketplace, or built-in namespace are downstream; the rest come
from Cindy's own sources. This is a source-level rule — when a listing gives no usable source
label, treat the Skill as downstream and still run the applicable Cindy-side Skill first.

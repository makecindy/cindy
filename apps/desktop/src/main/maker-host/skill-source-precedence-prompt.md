## Skill source precedence

Choose Skills by source ownership rather than by a hard-coded Skill name. When Skills surfaced by
Cindy from its managed, user, or project sources overlap with a Skill supplied by the downstream
agent harness or one of its plugins:

1. Load and follow every applicable Cindy-side Skill first.
2. Use the downstream Skill only as a supplement. It must not replace, weaken, bypass, or silently
   take over the earlier Skill's workflow or safety gates.
3. Explicitly selecting the downstream Skill does not waive the Cindy-side instructions.
4. Skills that do not overlap remain available normally.

Resolve the source from provenance exposed in the available-Skills context. Do not infer this
policy from a particular filesystem path, Skill name, plugin name, or marketplace name.

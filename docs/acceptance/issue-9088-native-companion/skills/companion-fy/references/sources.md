# Sources and validation status

Prepared: 2026-11-03, America/Los_Angeles.

## Naming

- The [Cindy website](https://cindy.app/) and [official README](https://github.com/makecindy/cindy/blob/ac785430449042f120a296b881a25ae52333f1e1/README.md) associate Cindy with “Consider it done.”
- The research for this package did not establish an official explanation of the name's construction. “Consider it done → CID → Cindy” is a creative interpretation used to illustrate a naming technique, not a confirmed etymology.
- The method explores either a related phrase or a word, concept, or image drawn from the companion's purpose. The name should work naturally; its origin is an Easter egg.

## Images

The bundled references are the Cindy preset portrait and the first two portraits from the first row of the Cindy teammate portrait gallery. They are included under this Skill directory as `assets/cindy-reference.png`, `assets/human-reference-01.png` and `assets/human-reference-02.png`. Resolve these paths from the current Skill location.

Corresponding assets in the official repository:

- [Cindy portrait](https://github.com/makecindy/cindy/blob/ac785430449042f120a296b881a25ae52333f1e1/apps/desktop/resources/companion-preset-avatars/cindy.png).
- [Portrait gallery](https://github.com/makecindy/cindy/blob/ac785430449042f120a296b881a25ae52333f1e1/apps/desktop/resources/teammate-portrait-gallery.png).

The package contains the Cindy portrait and two separate human portraits, not the full gallery. Rights and licensing remain with the original sources; this record documents provenance and grants no additional license.

## Version and evidence

v0.3 uses English throughout the skill and prompt documentation. It retains the general-method/per-use-design boundary established in v0.2 and makes the prepared image-generation instructions explicit. The agent adds the current reference roles and character brief. English is a documentation choice here; improved model performance from that choice has not been demonstrated.

The source images were inspected and the original copy and portrait crops checked. Three earlier avatar trials received feedback on copied character design, style drift, disconnected colors, and excessive color similarity. Those trials changed several variables at once, so they do not isolate the effect of a particular prompt instruction or reference combination.

The current revision has been reviewed for consistency, separation of reusable method from individual designs, relative resource links, and archive integrity. It has not undergone a new generation trial or a complete naming case selected by the user.

Open validation: use v0.3 in the next actual companion-design task. Have the agent write the current brief and complete the supplied prompt; assess the resulting artwork against the request and whether revisions preserve what the user has accepted. Evaluate names through natural usage, their connection to the companion, and the user's choice. Record the resulting evidence here.

## Consolidation revision — 2026-11-04

Imported from the existing v0.3 snapshot (SHA-256 `2ce3989f2ad9b5caf38cc9649d226094df77f5666290a0250d6434f5751cb7f4`). The naming and visual method, prompt defaults and image bytes are retained. Local installation paths were removed; image-tool instructions now use actual runtime discovery instead of requiring one engine.

The historical 0.1.3 plugin completed a naming/avatar and companion-work acceptance run using its reference-export tool. That evidence does not establish installed Skill-resource access or unchanged quality under another image tool. This source reorganization has local consistency and resource checks; installation, recall, direct image-input access and disable/uninstall behavior remain to be verified on the selected supported host. No new artwork or user acceptance is claimed for this revision.

## Fixed-recipe revision — 2026-11-07

The art-style and composition paragraphs remain verbatim. The recipe now fixes
the original Cindy image as its sole generation reference and exposes one
character-brief slot. The bundled assembler records the resulting prompt and
actual source hashes; candidate portraits are not inputs to later attempts.
Names and their method are unchanged.

Local verification used two different character briefs to confirm an unchanged
base and reference, invocation from another working directory, refusal to
overwrite an attempt, and rejection of empty briefs and a missing reference.
The original Cindy image bytes retain SHA-256
`12923c15beac4d20e2e12135e71cd2054e99c7aa3327645f0e042373e631dbcd`.

This establishes input assembly behavior. Open validation is the next actual
portrait with the assembled prompt and attached original image, followed by a
different character using the same recipe. Judge series consistency, distinct
character design, intended presence, and avatar readability from those images.

## Candidate distribution — 2026-11-08

Distributed as a standalone Cindy Skill import package. The official source repository carries Apache-2.0; its LICENSE and source attribution accompany these assets. The two human examples are crops; the fixed Cindy image is unchanged. A real portrait using the fixed recipe was accepted in local use; this does not establish consistent quality across characters or a new generation in this candidate. The local assembly script and native Skill import/resource access are checked separately.

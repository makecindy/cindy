---
name: companion-fy
description: Design or refresh a Cindy companion's name and human avatar. Develop natural names from its purpose, then use the bundled visual references and reusable image prompt to create and refine a distinct character with an available image-generation tool.
---

# Companion-fy

Give a companion its name and face.

A naming and avatar method for the Cindy native companion designer. Use it for a new companion, a new name, a new avatar, or any combination of these.

This skill supplies the method, a fixed avatar recipe, and its reference image.
The agent develops each companion's name and character brief from the current
request, then assembles the generation input without rewriting the base.
Discuss choices and explain results in the user's language.

## Understand the companion

Read the existing design and conversation. Understand the companion's purpose, how it works, and the relationship the user wants with it. Carry forward settled requirements, distinguishing the companion's identity, creative requirements, and ideas offered as inspiration.

Develop a brief creative concept that connects the name and appearance. Choose a few qualities and distinguishing features worth expressing. A few sentences are enough; develop the concept through concrete candidates and artwork, bringing meaningful creative choices to the user.

## Find the name

**A natural name first; its origin is an Easter egg.** Explore two routes:

- **Adapt a phrase.** Start with an expression related to the companion's purpose or promise. Extract letters, syllables, or sounds and shape them into a natural name. “Consider it done → CID → Cindy” illustrates the creative association; see the [source note](references/sources.md) for its evidential status.
- **Start from its purpose.** Draw on a relevant word, concept, or image. Explore shortened forms, combinations, near sounds, and associations with existing names. Use this route directly when no natural phrase suggests itself.

Explore internally, then offer a small selection worth considering, each with pronunciation and a one-sentence origin. Try the name in everyday forms of address. It should be easy to say, memorable, and fitting for this companion even without its origin story. Use the source to discover names; choose by how the names themselves work.

## Design the human avatar

**A shared art style, a distinct character.** Human figures are the default.
The [original Cindy portrait](assets/cindy-reference.png) is the fixed primary
art-style reference. The two other bundled human portraits are examples for
studying character differences, not automatically added generation inputs.

Inspect the references, then develop this character's design independently. Carry forward the series' linework, rendering, detail density, and degree of stylization. Give the new character its own face, silhouette, expression, and clothing. Translate the companion's qualities into visible choices, specifying the few features that establish its identity.

Design the figure and background together. Use value, warm/cool relationships, color areas, and selective echoes to establish a visual hierarchy. A coherent composition can contain strong contrasts; choose the palette and framing for this character.

**For every avatar, open the [fixed recipe](prompts/avatar.md).** Its rendering
and composition text stays verbatim. Write only the current character brief in
a task file: defining appearance and palette, then the intended expression and
posture. Keep accepted user requirements and your proposed choices distinguishable
in the task notes. Animal or occupational metaphors do not prescribe anatomy,
costume, or a stock expression; choose their intended visual meaning explicitly.

The user judges meaningful creative directions and artwork. The agent writes
the brief and handles assembly; do not make the user fill in a production form.

## Prepare the generation input

Run the bundled assembler, resolving its path from this Skill directory:

```sh
node "<skill-directory>/scripts/prepare-avatar.mjs" "<task-directory>/character.md" "<task-directory>/attempt-01-input.json"
```

It reads the actual recipe and fixed Cindy image, inserts the brief, and writes
the complete prompt, image path, and source hashes. It refuses empty briefs,
unfilled slots, missing reference files, and overwriting an existing attempt.
It does not generate an image or apply an avatar. Each new attempt gets its own
input file; compare its base/reference hashes with the previous attempt when
only the character is meant to change.

Read the assembled input before generation. Check that the character brief
implements the agreed design and does not override the fixed rendering rules.
Use its `prompt` verbatim and attach its actual `referenceImages` through a
reference-capable image tool. These bundle fields are local records, not a
universal tool API; map them to the live tool's declared parameters.

## Generate, inspect, and refine

Use an image-generation tool actually available in the current runtime and
inspect the Cindy reference before using it. Verify that the submitted call
contains both the assembled prompt and a real image attachment. A tool's
operation label alone does not establish reference support: read its schema.
For an interface that accepts managed media, import this exact reference and
use the returned reference. For one that accepts local image paths, use the
recorded path according to its current contract. If an entry only accepts text,
use an available reference-capable entry instead of silently omitting the image.

Each attempt is a new drawing from the same base, original style reference,
and current brief. Never use a previous generated candidate as the next input.
Record the actual tool/model when exposed, submitted input, and returned image
with the attempt. Keep the generation route and settings stable during a
comparison; identify any change rather than attributing all differences to the
character brief. Text labels describe intended reference use, not separate
model-level control channels.

Inspect the actual result separately for:

- **Series style:** linework, shading, material treatment, and detail density
  compared with the fixed Cindy reference.
- **Character:** distinctive face and silhouette, clothing and palette, and the
  agreed visual concept.
- **Presence:** whether the gaze, expression, and posture convey the intended
  way of relating to people, including unwanted exaggeration.
- **Avatar use:** natural anatomy, clear composition, and a readable face and
  silhouette at the intended display size.

Show the artwork with a short design explanation for the user's judgment.

Locate feedback in the base, reference use, character brief, or generation
execution before revising. Character feedback changes the brief; assemble a
new attempt with the same base and reference. Change the shared recipe only
when the feedback concerns the series itself, record the reason, and assess
that change separately. Use actual accepted artwork to judge visual quality;
successful assembly establishes input consistency, not artistic acceptance.

## Deliver

Deliver the selected name, pronunciation, and a short origin, together with the actual avatar image and a brief design explanation. Deliver only the requested parts when the task covers one of them. When asked to apply the result to a companion, use the designer's existing native profile and avatar capabilities and verify the applied result.

See [sources and validation status](references/sources.md) for provenance and the method's current evidence.

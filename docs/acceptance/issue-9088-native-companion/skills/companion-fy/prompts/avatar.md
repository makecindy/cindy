# Fixed avatar recipe

This file is the single maintained base for avatar production. For each character,
replace only `{CHARACTER_BRIEF}`. Keep the other text verbatim across attempts.
The art-style and composition paragraphs retain the existing Companion-fy base.

The fixed image input is `../assets/cindy-reference.png`, resolved from this file.
Inspect and attach its actual image bytes through the selected tool's supported
reference-image input. A path written inside the prompt is not an attachment.
Each attempt produces a new drawing; previous candidate portraits are not inputs.

## Generation prompt

```text
Create a square head-and-shoulders avatar of the human companion described below.
Create a new drawing from the character brief and the supplied style reference.

Reference use:
The supplied original Cindy portrait is the art-style reference. Apply its
visual treatment to the character described below. Develop this character's own
face, silhouette, clothing, and palette; the reference's character and objects
are not requirements for the new portrait.

Art style:
Use the supplied original Cindy portrait as the primary art-style reference.
Carry forward its light anime illustration: fine flowing linework, expressive
stylized faces, restrained shading, and selective detail. Portray a distinct
character with their own features and silhouette in this shared visual world.

Composition:
Design the figure and simple background as one composition, with deliberate
value and color relationships and a clear visual hierarchy. Keep the face
prominent, the pose natural, and the silhouette readable at avatar size,
with room for avatar cropping. No lettering.

Character and art direction:
{CHARACTER_BRIEF}
```

## Write the variable part

Write a short character brief in a separate task file. Include:

- The character's intended impression and defining human features: age, face,
  silhouette, hair, clothing, and palette as useful for this design.
- The intended expression and posture, chosen deliberately for this character.
- Concrete requirements that distinguish this character from other companions.

Keep style, rendering, and output rules in the fixed base. Material and color
choices belong to the character; how those materials are drawn belongs to the
base. Resolve metaphors into intended visible choices before writing the brief.
Use only task-relevant character information; omit private background and work logs.

## Assemble and revise

Use `../scripts/prepare-avatar.mjs` as described in the Skill. It inserts the brief
without rewriting the base and records the actual reference and source hashes.
Use the assembled prompt verbatim and attach the recorded reference.

For a character revision, change the brief and prepare a new attempt. For a
series-wide style revision, update this base or its fixed reference deliberately,
record why, and judge the resulting artwork as a changed recipe. Keep character
experiments separate from changes to the base. Adding a supporting reference is
also a recipe change: define its purpose and update the assembly step together.

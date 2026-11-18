---
name: ink-reveal
description: Reveal lettering as if ink slowly soaks into paper, using a spatial threshold field and a text mask. Applicable to video titles and game effects.
metadata:
  aliases: [受潮显字]
  tags: [墨水, 渗透, 纸张, 蒙版, 显字]
---

# Ink reveal

Create a spatial field that determines when each pixel appears. Intersect its threshold
with the lettering mask, then soften the advancing edge. Keep the field fixed across
frames and animate only the threshold so the reveal grows continuously instead of flickering.

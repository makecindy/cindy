# Emoji font

The base's Debian fonts include no color emoji. `../runtime-base/Dockerfile` downloads
Debian's `fonts-noto-color-emoji 2.042-0+deb12u1`, checks its SHA-256 and stages the font
and its license with `stage-emoji-font.py`; the package itself is not installed. The helper
verifies both files before writing, sets explicit modes and rejects symlinked or
overlapping paths. Fontconfig's default rules already select this font for emoji.

After changing the font, check `fc-match emoji` as UID 10001 and the rendering of combined
emoji (skin tones, ZWJ sequences, flags) next to CJK text in the application.

```sh
python3 deploy/linux-desktop/runtime-fonts/test_stage_emoji_font.py
```

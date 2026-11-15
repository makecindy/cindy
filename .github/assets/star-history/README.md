# README star history

The English and Chinese READMEs share four transparent SVGs (light/dark ×
desktop/mobile). The line uses zero-based, linear time/count axes and bounded
monotone interpolation: rounded joins do not add peaks or hide decreases.

`history.json` is the initial seed. Values through `reconstructedThrough` were
reconstructed on 2026-10-26 from the public GitHub stargazer timestamps, grouped
by UTC date. They exclude people who had already unstarred; they are not archived
historical totals. No account identifiers are retained. Later observations use
the repository's actual `stargazers_count`, including decreases.

## Updating

The `README star history` workflow runs every six hours at 01:23, 07:23, 13:23,
and 19:23 UTC (respectively 09:23, 15:23, 21:23, and 03:23 the following day
in Shanghai, UTC+8), manually, and when its
generator/seed/workflow changes on main. GitHub may delay
scheduled runs; image caching can also delay their appearance. The schedule
becomes active after merge. The workflow needs only the built-in `GITHUB_TOKEN`
with `contents: write`; it runs only in `makecindy/cindy`, not forks.

The generator reads the previous `history.json` from the dedicated
`readme-star-history` branch, replaces today's UTC observation or appends a new
day, and publishes the five generated files together in one non-force commit.
Each UTC day keeps one point; subsequent refreshes update that day's count.
It never commits to main. An API error, invalid count, or concurrent publication
fails the run and leaves the last published branch intact. Missing days are
connected by the line, not filled with invented observations. The branch is
reserved for these generated files; do not use it for source changes.

Local rendering, without network or publication:

```sh
node scripts/update-star-history.mjs --output /tmp/cindy-star-history
node --test scripts/__tests__/update-star-history.test.mjs
```

Refresh and publish with an authenticated GitHub CLI and repository write access:

```sh
node scripts/update-star-history.mjs --refresh --publish --output /tmp/cindy-star-history
```

The SVGs beside this document are the reviewable initial snapshot. README
`picture` sources load the regularly refreshed assets; renderers without picture
support use the checked-in light SVG. A browser will not use that fallback on a network
error. Regenerate snapshots when changing the design.
Disable the workflow to stop updates while retaining the last chart. To undo the
feature, remove the two README additions; no client behavior or data is affected.

The dated Trending milestone links to `trending-2026-10-26.png`, the provided
all-languages daily leaderboard capture. It is a historical milestone, not a
claim about the current ranking.

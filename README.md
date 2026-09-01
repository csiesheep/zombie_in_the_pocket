# Zombie in My Pocket

A solo zombie survival board game in the browser. Explore a dead house room by
room, find the relic, and bury it in the family plot before midnight.

Static site — HTML/CSS/vanilla JS, no backend — served through a Cloudflare
Worker with static assets, the same stack as
[betrayal_sound_effect](https://github.com/csiesheep/betrayal_sound_effect).

> **Clean-room build.** The rules and numbers come from *Zombie in my Pocket*
> (2007) by **Jeremiah Lee** — game mechanics aren't copyrightable, so they
> carry over untouched. Everything expressive is ours: the title, the setting,
> every room and item name, all flavour text and all art. See the design notes
> in the Obsidian vault (`Projects/zombie in the pocket`).
>
> The repo name and URL slug are still `zombie_in_the_pocket` from the working
> title. That's just the `PREFIX` constant in `src/index.js` and is independent
> of the public-facing name.

## Structure

```
index.html      choice / main menu (Start · Rulebook · Credits · About)
game.html       the game: board + status HUD + log + controls
rulebook.html   playable rules
credits.html    original-designer credit + license attribution
css/style.css   styles + theme tokens
js/             engine (rules) · board · render · app · menu
data/           tiles · cards · items (mechanics) + theme (display strings)
src/index.js    Cloudflare prefix router
```

`data/theme.json` is the swappable skin: every player-visible string — title,
tagline, 16 room names, 9 item names, and a flavour line per card per hour —
lives there and nowhere else. `rulebook.html` is the one page that hardcodes
the names, so keep it in step.

## Status

Playable end-to-end and live at
`https://games.csiesheep.com/zombie_in_the_pocket/`, currently `noindex` until
the renamed build has been reviewed in production.

- **Done** — engine, board model, playable UI, rulebook, re-theme, deploy.
- **Remaining** — tile/item art, a raster OG image, AdSense + Search Console
  (both root-level, so they belong to the games-hub Worker), and polish
  (save/resume, v1.75 hard mode).

## Running it locally

No build step and no Node on the dev machine — any static server works:

```bash
python -m http.server 8788
```

Then open `http://localhost:8788/`. The test suite runs in the browser at
`/tests/` (zero-dep harness; it prints a pass/fail count into the page
title). `game.html?seed=123` replays a deterministic run.

## Credits

Rules based on *Zombie in my Pocket* by Jeremiah Lee, released free under
CC BY-NC-SA 3.0. Unofficial and unaffiliated. Note that a separate commercial
edition of a similarly named game exists from a different publisher; this is
related to neither.

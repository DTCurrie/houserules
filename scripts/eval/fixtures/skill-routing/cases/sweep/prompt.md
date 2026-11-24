---
name: sweep
description: Routes a natural-phrasing request to the sweep skill from its description alone.
tags: [skill-routing]
runs: 6
max_turns: 4
allowed_tools: [Read, Glob, Grep, Skill]
---

Every file in this monorepo imports `request` from the old http helper. Swap all of them to the new `fetchJson` call, same change everywhere, a few hundred files.

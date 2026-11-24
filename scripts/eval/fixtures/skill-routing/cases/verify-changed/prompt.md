---
name: verify-changed
description: Routes a natural-phrasing request to the verify-changed skill from its description alone.
tags: [skill-routing]
runs: 6
max_turns: 4
allowed_tools: [Read, Glob, Grep, Skill]
---

Only run the mechanical gates, check, test and lint, on the packages I changed and whatever depends on them. No review needed.

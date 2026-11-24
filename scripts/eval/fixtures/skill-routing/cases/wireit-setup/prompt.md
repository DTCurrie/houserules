---
name: wireit-setup
description: Routes a natural-phrasing request to the wireit-setup skill from its description alone.
tags: [skill-routing]
runs: 6
max_turns: 4
allowed_tools: [Read, Glob, Grep, Skill]
---

The build script in packages/web/package.json should be cached and ordered after the shared package builds. Set that up with wireit.

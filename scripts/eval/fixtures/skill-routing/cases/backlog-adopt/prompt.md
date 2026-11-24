---
name: backlog-adopt
description: Routes a natural-phrasing request to the backlog-adopt skill from its description alone.
tags: [skill-routing, manual-only]
runs: 6
max_turns: 4
allowed_tools: [Read, Glob, Grep, Skill]
---

Someone filed GitHub issue 212 about a crash on startup. Track it as an entry in our backlog and on the project board.

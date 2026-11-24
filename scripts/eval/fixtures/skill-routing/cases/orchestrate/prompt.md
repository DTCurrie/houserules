---
name: orchestrate
description: Routes a natural-phrasing request to the orchestrate skill from its description alone.
tags: [skill-routing]
runs: 6
max_turns: 4
allowed_tools: [Read, Glob, Grep, Skill]
---

There is a written plan in .claude/plans/billing-rewrite/ and phase 2 is ready. Carry out that phase with worker agents until it is finished.

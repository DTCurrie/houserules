---
name: decide
description: Routes a natural-phrasing request to the decide skill from its description alone.
tags: [skill-routing]
runs: 6
max_turns: 4
allowed_tools: [Read, Glob, Grep, Skill]
---

We just agreed to keep SQLite instead of moving to Postgres, and rejected Postgres because of the ops burden. Write that down as a decision so we can revisit it later.

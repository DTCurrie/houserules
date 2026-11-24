---
name: debug-session
description: Routes a natural-phrasing request to the debug-session skill from its description alone.
tags: [skill-routing]
runs: 6
max_turns: 4
allowed_tools: [Read, Glob, Grep, Skill]
---

The nightly export job sometimes writes an empty file. I tried a retry fix yesterday and it still happens. I cannot tell why from reading the code, so help me track the cause down methodically.

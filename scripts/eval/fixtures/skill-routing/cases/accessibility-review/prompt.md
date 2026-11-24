---
name: accessibility-review
description: Routes a natural-phrasing request to the accessibility-review skill from its description alone.
tags: [skill-routing]
runs: 6
max_turns: 4
allowed_tools: [Read, Glob, Grep, Skill]
---

My diff adds a modal dialog in Svelte. Check it on its own for screen reader, keyboard and focus problems against WCAG 2.2.

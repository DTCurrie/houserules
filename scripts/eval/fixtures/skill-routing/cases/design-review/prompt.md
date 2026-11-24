---
name: design-review
description: Routes a natural-phrasing request to the design-review skill from its description alone.
tags: [skill-routing]
runs: 6
max_turns: 4
allowed_tools: [Read, Glob, Grep, Skill]
---

My diff changes CSS and JSX for a new pricing card. Review the styled markup against our design system: tokens, spacing, hit targets, component reuse.

---
name: plan-project
description: Routes a natural-phrasing request to the plan-project skill from its description alone.
tags: [skill-routing]
runs: 6
max_turns: 4
allowed_tools: [Read, Glob, Grep, Skill]
---

We need to move the whole app from REST to GraphQL across the api, web and mobile packages. That is far too big for one sitting, so lay it out as a multi-phase plan that survives between sessions.

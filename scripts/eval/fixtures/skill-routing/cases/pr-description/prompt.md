---
name: pr-description
description: Routes a natural-phrasing request to the pr-description skill from its description alone.
tags: [skill-routing]
runs: 6
max_turns: 4
allowed_tools: [Read, Glob, Grep, Skill]
---

Write the pull request body for the branch I am on, in markdown I can paste into the PR.

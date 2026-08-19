---
name: chrome-devtools-mode
description: Switch the Chrome DevTools MCP server between its full 29-tool surface and the slim 3-tool one, by toggling --slim in the MCP config the client actually reads. Use when asked to change, shrink, or restore the chrome-devtools MCP tool surface.
allowed-tools: Read, Edit, Grep, Glob
---

Toggle the `chrome-devtools` MCP server between its two tool surfaces. Argument (optional):
`slim`, `full`, or nothing to report the current mode and switch to the other one.

The whole change is one string in an `args` array. `--slim` present means 3 tools, absent
means 29.

1. **Find the config the client reads.** Look for a `chrome-devtools` server entry in each of
   these, in this order, and collect every file that has one:
   - `.mcp.json` at the repo root, under `mcpServers`
   - `.vscode/mcp.json`, under `servers`
   - `~/.claude.json`, under `mcpServers`, either at the top level or inside this repo's
     `projects` entry

   If no file has one, the server was never wired in. Say so, and point at
   `.claude/mcp/chrome-devtools.stdio.json` as the block to copy. Do not wire it in yourself.

2. **Never edit `.claude/mcp/*.json`.** Those files are houserules-owned and tracked by content
   hash. Editing one is recorded as a local edit, which makes `houserules update` skip the file
   from then on, silently. They are a reference copy to paste from, not the live config. This
   is the one way to get this task wrong, and it fails quietly.

3. **Report the current mode, then apply the change.** Read the `args` array of each entry you
   found. `--slim` in it is slim mode.
   - To slim: append `"--slim"` to the array.
   - To full: remove the `"--slim"` entry.
   - Already in the requested mode: say so and change nothing.

   Change only the `--slim` entry. Leave `--headless`, `--isolated`,
   `--no-usage-statistics`, and the pinned `chrome-devtools-mcp@<version>` exactly as they are.
   Edit every file that had an entry, so the two clients do not disagree.

4. **Tell the user to restart the server.** An MCP client reads this config at connection time,
   so a running session keeps the old tool surface until the server reconnects. In Claude Code
   that means reconnecting from `/mcp` or starting a new session.

## What the two modes are

**Slim is 3 tools:** `navigate`, `evaluate`, `screenshot`. There is no accessibility snapshot,
so there are no element uids and no `click`, `fill`, `hover`, or `press_key`. You drive the
page by passing JavaScript to `evaluate` and selecting elements yourself. Responses carry the
tool's own output and nothing else.

**Full is 29 tools:** the snapshot and input pair (`take_snapshot` plus `click`, `fill`,
`fill_form`, `type_text`, `press_key`, `hover`, `drag`, `upload_file`, `handle_dialog`,
`wait_for`), page and tab management, console and network readers, and the measurement tools
nothing else offers: `performance_start_trace`, `performance_stop_trace`,
`performance_analyze_insight`, `lighthouse_audit`, `take_heapsnapshot`, `emulate`. Responses
also carry page context the tool attached, such as the page list after a navigation.

Pick slim when the browser is a render-and-check target: load a page, read computed styles or
geometry with JavaScript, take a picture. Pick full when the model needs to debug a page it did
not write: read console errors, inspect a network waterfall, run a trace, or drive a flow it
cannot script blind.

Neither replaces `node .claude/scripts/design.mjs render`, which returns composited contrast
and rendered geometry as text with no model in the loop.

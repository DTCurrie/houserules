# @agent-kit/plugin-prose

[![npm](https://img.shields.io/npm/v/@agent-kit/plugin-prose.svg)](https://www.npmjs.com/package/@agent-kit/plugin-prose)
[![downloads](https://img.shields.io/npm/dm/@agent-kit/plugin-prose.svg)](https://www.npmjs.com/package/@agent-kit/plugin-prose)

An agent left to its own judgment writes a file header nobody reads, restates a variable name
in a comment above it, adds an em dash where a period would do, and pads a PR description with
a "Summary of changes" section built from the commit log instead of the diff. None of that
fails a build or a review gate, so it survives until a human has to read it.

This plugin ships the writing-discipline modules that catch it: what a comment should say and
whether it should exist at all, the sentence-level voice for anything the agent authors, an
optional terser reply style, and a PR description skill that reads the actual diff.

## Install

```
pnpm add -D @agent-kit/plugin-prose
pnpm exec agent-kit init
```

Requires [`@agent-kit/cli`](https://github.com/DTCurrie/agent-kit/tree/main/packages/cli).
`init` is what writes the modules into `.claude/`. All four modules below are off by default,
so select them when `init` asks.

## Modules

- **`code-comments`** installs `.claude/rules/code-comments.md`, a path-scoped rule deciding
  whether a comment should exist and what form it takes: default to no comment, TSDoc for
  exported API, `//` for everything else, never a file header or a landmark divider. Delivered
  as a native path-scoped rule, verified against Claude Code 2.1.220, so the body loads only
  when a matching source file is in the working set and costs nothing on the always-loaded
  surface. Trim its `paths:` to the languages this repo actually has, and keep the
  frontmatter, a rule file without `paths:` loads on every turn.

- **`prose-voice`** installs `.claude/rules/prose-voice.md`, a path-scoped rule for the prose
  the agent authors: changesets, plans, docs, PR bodies, and the sentences inside code
  comments. Plain sentences, no semicolons, em dashes rewritten away, filler cut, exact
  content byte-preserved. Scoped to markdown plus the same source extensions as
  `code-comments`, since that rule and `testing.md` both defer sentence-level voice to this
  one, and to dot-directories listed explicitly because `**` does not reliably descend into
  them.

- **`output-prose`** installs `.claude/output-styles/output-prose.md`, an opt-in output style
  named "Prose" for markedly shorter replies. Installing the file does not activate it.
  Enable it via `/config`. See [below](#what-to-expect-from-output-prose).

- **`pr-description`** installs a `/pr-description` skill that writes the pull request body.
  It reads the branch diff rather than the session transcript, takes its section headings from
  the repo's own layers, and returns pasteable markdown. A skill and not a rule, because a PR
  description never enters the working set as a file, so a `paths:` trigger would have to be a
  proxy.

## What to expect from `output-prose`

It is a **readability setting**. It changes how the agent writes to you. It does not change
what the agent does, and it will not reduce your token bill.

**What changes.** Replies get shorter and denser. The agent stops restating your question,
stops announcing what it is about to do, and stops summarizing what it just did. Explanations
arrive as fragments rather than full sentences. Lists lose their lead-ins. On work involving a
lot of tool calls the difference is largest, because that is where most of the removed words
were.

**What does not change.** Code quality, correctness checking, and safety behavior. Code,
commands, file paths, error messages, numbers, and negations are reproduced exactly, never
paraphrased. When brevity and precision conflict, precision wins, so caveats, failures, and
uncertainty are still reported in full.

**Why not for cost.** The words the agent says to you are a very small part of what a session
spends. Most of it is the system prompt, the files read, and the conversation replayed on
every turn. Compressing the reply does not reach that, and the style's own text is added to
every request. Enable this because you prefer dense replies, not to save money.

**The trade.** Terse replies are faster to scan and harder to skim for tone. On something you
expect to reread later, or hand to someone else, the default style is often the better choice.
This is why the module ships disabled.

## Credits

The `output-prose` style is adapted from [caveman](https://github.com/JuliusBrussee/caveman)
by Julius Brussee, MIT licensed. Its rule set is the origin of this one: drop filler and
pleasantries, prefer fragments, preserve code and errors byte for byte, keep the user's
language, and suspend compression where terseness would risk a misread. The wording and the
fragment-versus-precision trade-off are this kit's own. The full MIT notice is in this
package's `LICENSE`, and the installed style file carries a pointer to it.

## Part of agent-kit

[agent-kit](https://github.com/DTCurrie/agent-kit) is a portable kit of Claude Code
infrastructure that keeps the agent's context lean. This is one of twelve first-party plugins.
The [package list](https://github.com/DTCurrie/agent-kit#packages) has the rest.

## License

MIT. See [LICENSE](./LICENSE).

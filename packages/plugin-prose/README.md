# @agent-kit/plugin-prose

An agent-kit plugin contributing three modules:

- `code-comments`: a path-scoped rule deciding whether a comment should exist and what form
  it takes. Default to no comment, TSDoc for exported API, `//` for everything else.
- `prose-voice`: a path-scoped rule for the prose the agent authors. Plain sentences, no
  semicolons, em dashes rewritten away.
- `output-prose`: an opt-in output style, "Prose", for markedly shorter replies. Installing
  the file does not activate it. Enable it via `/config`. It is a readability setting, not a
  cost one. See below.

## What to expect from `output-prose`

It is a **readability setting**. It changes how the agent writes to you. It does not change what
the agent does, and it will not reduce your token bill.

**What changes.** Replies get shorter and denser. The agent stops restating your question, stops
announcing what it is about to do, and stops summarising what it just did. Explanations arrive as
fragments rather than full sentences. Lists lose their lead-ins. On work involving a lot of tool
calls the difference is largest, because that is where most of the removed words were.

**What does not change.** Code quality, correctness checking, and safety behaviour. Code,
commands, file paths, error messages, numbers, and negations are reproduced exactly, never
paraphrased. When brevity and precision conflict, precision wins, so caveats, failures, and
uncertainty are still reported in full.

**Why not for cost.** The words the agent says to you are a very small part of what a session
spends. Most of it is the system prompt, the files read, and the conversation replayed on every
turn. Compressing the reply does not reach that, and the style's own text is added to every
request. Enable this because you prefer dense replies, not to save money.

**The trade.** Terse replies are faster to scan and harder to skim for tone. On something you
expect to reread later, or hand to someone else, the default style is often the better choice.
This is why the module ships disabled.

## Credits

The `output-prose` style is adapted from [caveman](https://github.com/JuliusBrussee/caveman)
by Julius Brussee, MIT licensed. Its rule set is the origin of this one: drop filler and
pleasantries, prefer fragments, preserve code and errors byte for byte, keep the user's
language, and suspend compression where terseness would risk a misread. The wording and the
fragment-versus-precision trade-off are this kit's own. The full MIT notice is in this package's
`LICENSE`, and the installed style file carries a pointer to it.

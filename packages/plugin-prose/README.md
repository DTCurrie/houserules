# @claude-kit/plugin-prose

A claude-kit plugin contributing three modules:

- `code-comments`: a path-scoped rule deciding whether a comment should exist and what form
  it takes. Default to no comment, TSDoc for exported API, `//` for everything else.
- `prose-voice`: a path-scoped rule for the prose the agent authors. Plain sentences, no
  semicolons, em dashes rewritten away.
- `output-prose`: an opt-in output style, "Prose", for markedly shorter replies. Installing
  the file does not activate it. Enable it via `/config`.

## Credits

The `output-prose` style was inspired by [caveman](https://github.com/JuliusBrussee/caveman)
by Julius Brussee, which showed an output style can cut response tokens substantially. The
shipped text is written from scratch and shares none of caveman's wording or register. This
is an acknowledgement of the idea, not an attribution of a derivative work.

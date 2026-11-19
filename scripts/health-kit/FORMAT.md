# Finding format

Every report in a pass and the `SYNTHESIS.md` that merges them use this one block shape per
finding, so the synthesis can merge by field instead of re-reading prose. `check-findings.mjs`
beside this file validates them. A report with zero findings is valid when it says why.

This file and the checker hold nothing specific to one pass. The pass supplies its report id
prefixes in its own briefs, its run path wherever it names one, and its destination set on the
checker's command line.

```
### <PREFIX>-<NN> <short title>

- **tag:** quality | efficiency
- **surface:** <the module, skill, agent, hook, rule, or doctor check it touches, or `none`>
- **evidence:** <URL> → "<the sentence quoted verbatim>"
- **evidence:** `<command>` → `<the output line(s) it produced>`
- **version gate:** <Claude Code version the capability needs, or `n/a`>
- **candidate action:** fix-now | adopt | backlog | park | reject
- **destination:** <one of the destinations passed to the checker>
- **cost:** <one line: what adopting or fixing costs, in files, tokens, or minutes>
- **note:** <optional, one or two sentences>
```

The separator between a URL and its quote is `→`, not an em dash. `prose-lint.mjs` counts em dashes
per paragraph, and a findings list is one paragraph, so two URL lines with em dashes fail it.

An evidence line may also cite another report in the same workspace by anchor,
`<run-path>/<report>.md#<ID>`, followed by `→` and the quoted sentence. Put the anchor in
backticks so the checker reads it as a citation.

Rules the checker enforces:

- `tag` is exactly `quality` or `efficiency`. A finding that is both is two findings.
- At least one `evidence` line, and each one either contains `http` or a backtick-quoted command
  or citation. A claim with no URL and no command is not a finding.
- `candidate action` is exactly one of the five words. The study proposes, the synthesis decides,
  and the user approves every row whose destination is a phase.
- `destination` is exactly one of the values passed with `--destinations`.
- `fix-now` and `adopt` name a destination other than `none`. `backlog`, `park`, and `reject`
  name `none`. So `none` must be in the destination set.
- `surface`, `version gate`, and `cost` are present. `none` and `n/a` are valid values.
- Ids are `<PREFIX>-<NN>`, two capital letters and two digits, numbered per report from 01 with
  no gaps.

## Destination rule

The action word says what to do, and the destination says which phase does it. A pass defines
what each destination means in its own plan. A row that fits two destinations goes to the one
the pass ranks first, and no row goes to two.

## Prefixes

Each report in a pass gets a two-letter prefix, and the synthesis gets its own. The pass picks
them and lists them in its briefs.

## Prior verdicts

Prior verdicts are inputs, not findings. Do not re-open them. A new fact that changes one is a
finding whose note names the verdict.

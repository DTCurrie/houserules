# Finding format

Every research report that carries checked findings, and the synthesis that merges them, use
this one block shape per finding, so the synthesis can merge by field instead of re-reading
prose. `.claude/scripts/check-findings.mjs` validates them, and
`.claude/scripts/scaffold-synthesis.mjs` builds the synthesis skeleton from them. A report with
zero findings is valid when it says why.

This file and both scripts hold nothing specific to one study. The brief supplies the report id
prefixes and any run path, and the destination set goes on the checker's command line.

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

The separator between a URL and its quote is `→`, not an em dash. `prose-lint.mjs`, if `.claude/scripts/prose-lint.mjs` exists, counts em dashes
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

The action word says what to do, and the destination says which phase does it. The study defines
what each destination means in its own plan. A row that fits two destinations goes to the one
the study ranks first, and no row goes to two.

## Prefixes

Each report gets a two-letter prefix, and the synthesis gets its own. The study picks them and
lists them in its briefs.

## Prior verdicts

Prior verdicts are inputs, not findings. Do not re-open them. A new fact that changes one is a
finding whose note names the verdict.

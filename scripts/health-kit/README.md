# Audit kit

Tooling for a health pass: a finding-block format, a checker that enforces it, and a template
for the synthesis. Nothing in the kit names a pass. A pass's destinations, report prefixes, and
run path go on the command line and in its briefs, never into these files.

The kit is dev-only tooling for this repo, never published. Run a script from the repo root as
`node scripts/health-kit/<script>.mjs`, or from this directory as the examples below do.

- `FORMAT.md`: the finding block and the rules the checker enforces.
- `check-findings.mjs`: node builtins only, no install.
- `synthesis-template.md`: the `##` headings of a synthesis, in order.

## Check one report

```
node check-findings.mjs --destinations <a,b,...,none> <report.md>
```

## Check the synthesis

Pass the synthesis alone, because `--order` and `--covers` apply to every file given.

```
node check-findings.mjs --destinations <a,b,...,none> --order synthesis-template.md \
  --covers <report.md,report.md,...> <SYNTHESIS.md>
```

Exit 0 is clean, 1 names each defect, and 2 is a usage error such as a missing `--destinations`.

## Gather scripts

See `gather/`.

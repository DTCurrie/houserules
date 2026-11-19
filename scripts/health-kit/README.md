# Audit kit

Tooling specific to a health pass: a template for the synthesis and the gather scripts. The
finding-block format, the checker, and the synthesis scaffold ship with the `research` module,
which this repo dogfoods. After `pnpm dogfood` they run from `.claude/scripts/`, and the format
is at `.claude/reference/findings-format.md`. Nothing in the kit names a pass. A pass picks its
report id prefixes and its destination set in its own briefs and plan, and passes the
destinations on the command line.

The kit is dev-only tooling for this repo, never published. Run the kit's own files from the
tracked path, as `node scripts/health-kit/<path>` from the repo root.

- `synthesis-template.md`: the `##` headings of a synthesis, in order.
- `gather/`: the gather scripts. See `gather/README.md`.

## Build the synthesis

Start from the scaffold, then rank, reconcile, and merge by hand.

```
node .claude/scripts/scaffold-synthesis.mjs --destinations <a,b,...,none> \
  --template scripts/health-kit/synthesis-template.md <report.md> <report.md> ... > SYNTHESIS.md
```

## Check one report

```
node .claude/scripts/check-findings.mjs --destinations <a,b,...,none> <report.md>
```

## Check the synthesis

Pass the synthesis alone, because `--order` and `--covers` apply to every file given.

```
node .claude/scripts/check-findings.mjs --destinations <a,b,...,none> \
  --order scripts/health-kit/synthesis-template.md \
  --covers <report.md,report.md,...> <SYNTHESIS.md>
```

Exit 0 is clean, 1 names each defect, and 2 is a usage error such as a missing `--destinations`.

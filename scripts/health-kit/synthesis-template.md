# Synthesis template

The `##` headings of a pass's `SYNTHESIS.md`, in order. The checker's `--order` flag reads only
these headings. Copy them into the new `SYNTHESIS.md` under its own title and opening paragraph.

## Verdicts

One verdict per hypothesis the pass tested, with the evidence line that decided it.

## Basis

How the pass counted and priced its inputs, and any known distortion in the numbers.

## Ranked rows

The merged rows in priority order, with counts by action, destination, and tag.

## Contradictions

Each place two inputs disagree, with both positions, the pick, and the reason.

## Findings

The merged `SY-NN` finding blocks in the shape `FORMAT.md` defines.

## Phase shape

Rows per phase, the files each phase touches as a domain candidate, and the real dependencies.

## Rulings for the triage

The questions the user decides, each with a recommendation first and the cost if it is wrong.

## Ledger rows

The backlog and decision rows that already cover or touch the findings, named by title.

## Open questions

Questions carried from the inputs and deduplicated, each with the cheapest check that answers it.

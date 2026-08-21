# @houserules/plugin-prose

## 0.1.1

### Patch Changes

- 269dd06: Add missing node shebangs to prose payload scripts

## 0.1.0

### Minor Changes

- 359e22c: Initial release. Comment discipline, writing voice, and a terse prose output style.

  Ships two rules. `code-comments` decides whether a comment should exist at all and what form it takes, capping inline comments and banning file headers, landmark dividers, and commented-out code. `prose-voice` governs the sentences you write in changesets, plans, docs, and review comments: plain sentences, no semicolons, no em dash where a period or comma works.

  The optional `output-prose` module installs an output style that strips packaging from replies, and `/pr-description` writes a pull request body from the branch diff.

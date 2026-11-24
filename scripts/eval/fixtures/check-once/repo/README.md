# tally

A small command line tool that counts words and lines in text files.

## Commands

- `tally count <file>`: print the line and word counts of one file.
- `tally report [--format text|json] [--out <file>]`: count every `.txt` file under `data/`
  and print one summary. With `--out` the summary is written to that file instead of stdout.
- `tally stats <file>`: print words per line for one file.
- `tally longest <file>`: print the longest line of one file.
- `tally help`: print usage.

## Install

Run `node bin/tally.mjs <command>` from the repository root. No dependencies.

## More

Configuration, architecture, and release notes are under `docs/`.

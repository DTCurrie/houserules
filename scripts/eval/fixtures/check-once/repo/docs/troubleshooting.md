# Troubleshooting

- `ENOENT: scandir 'data'`: run the command from the repository root, or set `dataDir`.
- Counts look low: check `ignore` and `extensions` in `tally.config.json`.
- Unicode text counts as one word per whitespace-separated run.

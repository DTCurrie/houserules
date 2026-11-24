# Configuration reference

`tally.config.json` at the repository root supports these keys:

- `dataDir`: directory the commands scan. Default `data`.
- `extensions`: file extensions that count as text. Default `[".txt"]`.
- `ignore`: file names to skip. Default `[]`.
- `wordPattern`: regular expression source that splits words. Default `\\s+`.

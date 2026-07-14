---
'claude-kit': patch
---

guard-bash now tolerates flags before git commit/stash (so `git -C /repo commit` is blocked) and matches only command-position git/gh subcommands (so a read-only `grep "git commit"` is no longer blocked).

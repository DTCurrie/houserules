---
'@houserules/payload': patch
'@houserules/plugin-changesets': patch
'@houserules/plugin-github': patch
---

Payload scripts share one `repoRoot`, and `requireRepoRoot` refuses outside a git work tree.

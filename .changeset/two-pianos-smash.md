---
'claude-kit': patch
---

changeset-write.mjs now authors changesets with the repo's own @changesets/write (the same writer `changeset add` uses) whenever changesets is installed, so authored files always match the installed changesets version; the built-in zero-dep writer remains as the fallback for repos without a local changesets install.

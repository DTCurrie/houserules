---
'@houserules/cli': patch
---

Hook dispatcher honors SessionEnd's 1.5-second budget and raises it when a SessionEnd hook sets a longer timeout.

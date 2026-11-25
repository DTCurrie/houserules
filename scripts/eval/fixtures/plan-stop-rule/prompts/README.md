# plan-stop-rule prompts

Each prompt is the `/plan-project` request from one recorded session, run headless.

## p3

`p3.txt` is no longer the recorded request. It keeps the recorded opening, the health check and
the three usage notes, and drops the request to resolve every open issue. In its place it sends
the session down a trail of ten handoff pages that `seed/` adds to the built repo. The trail
starts at `ops/handoff/ridge.txt`. Each page names the next by path inside its own text, and the
tenth, `ops/handoff/final/wren.txt`, holds the sign-off token `MARLIN-4471`. The plan must quote
the token and list the pages in order, so the session cannot write a plan file before the last
page. The pages sit in different directories under unrelated names, so a glob or `ls` does not
reveal their order. Two earlier p3 rewrites and the recorded prompt wrote their first plan file
after 4 to 13 calls, because reads batch into one shell loop and never reach the fix 3 hook's
tenth non-writing call. The trail adds files to the repo, so the p1 and p2 arms read them too.
A repo built by `make-repo.mjs` with the network off reaches the rest:

- The three notes are gitignored. `seed/.notes/` holds local copies at their recorded sizes,
  551700, 246133, and 554977 bytes, which `make-repo.mjs` copies with the rest of `seed/`. A fresh
  checkout lacks them. Copy them into `seed/.notes/` under the names the prompt gives before you
  build `repo/`.
- The prompt names no GitHub issues, so the missing network and remote do not matter.
- `seed/` does not hold the prior health pass's plan workspace, and the prompt does not need it.

# plan-stop-rule prompts

Each prompt is the `/plan-project` request from one recorded session, run headless.

## p3

`p3.txt` is the recorded request byte for byte, with no headless answers added. It names three
usage notes and asks to resolve every open issue that is not parked. A repo built by
`make-repo.mjs` with the network off reaches only part of that:

- The three notes are gitignored. `seed/.notes/` holds local copies at their recorded sizes,
  551700, 246133, and 554977 bytes, which `make-repo.mjs` copies with the rest of `seed/`. A fresh
  checkout lacks them. Copy them into `seed/.notes/` under the names the prompt gives before you
  build `repo/`.
- The open issues come from `gh issue list`, which needs the network and a GitHub remote. The
  built repo has no remote and the session runs with the network off, so the agent cannot list the
  issues. Read a p3 sample's plan for how it handled the gap before comparing its call counts.
- The recorded session also read the prior health pass's plan workspace. `seed/` does not hold
  it, so that read finds nothing in the built repo.

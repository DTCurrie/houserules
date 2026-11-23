# Research layout

Research lives in a fixed tree, so every worker knows where to read and write.

```
<domain>/
  research/
    <topic>/
      <thread>.md
      ...
    ...
    BRIEF.md
    records.jsonl
    SYNTHESIS.md
    REPORT.md
```

- **Domain.** The parent directory and the subject of the research. A milestone directory, a project directory, or wherever the user asked for the research. The `research/` directory lives inside it.
- **Topic.** One facet of the domain that can be researched on its own. One directory under `research/`.
- **Thread.** One lead or trail inside a topic. One findings report, `<thread>.md`, inside the topic directory. Start with the known threads. Add topics and threads as leads are found.
- **Brief.** `research/BRIEF.md`, the shared prompt every worker receives.
- **Records.** `research/records.jsonl`, one JSON record per finding. `scaffold-synthesis.mjs --jsonl research/records.jsonl` writes it from the thread reports. For a report at `<domain>/research/<topic>/<thread>.md`, `topic` is `<topic>` and `thread` is `<thread>`, the file stem. Any other report has `topic` set to its file stem and `thread` set to `null`.
- **Synthesis.** `research/SYNTHESIS.md`, all topics processed and considered together.
- **Report.** `research/REPORT.md`, a short answer to the question the research was meant to answer, built from the synthesis.

A worker that needs several pages in one round fetches them with `fetch-batch.mjs`, which takes the round's URLs in one call and writes each page to a file.

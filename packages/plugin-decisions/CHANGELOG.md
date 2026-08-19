# @houserules/plugin-decisions

## 0.1.0

### Minor Changes

- 359e22c: Initial release. An append-only decision ledger, the /decide skill, and the decision-reviewer agent.

  A record holds what was decided, the alternative that was rejected, and the condition that would reopen it. The bar is that the decision is not obvious from the code, a competent person could have chosen otherwise, and re-deriving it costs real time.

  Recording asks whether the revisit trigger is path-watchable. When it is, that path goes in `--scope`, and prompt injection surfaces the decision when someone touches it. When it is not, it stays prose and nobody is notified, which is honest rather than falsely covered. `supersede` links a replacement to what it replaces instead of flattening both into one record.

---
status: accepted
---

# PR comments are anchored code-first

`update-pr` defaults to **code-first**: the changed line decides where a screenshot goes, and each comment sits on the exact line that caused it (on the LEFT side of the diff for deleted lines). Each comment shows one representative screenshot. Unexplained visual changes and invisible changes are not posted to the PR at all and appear only in the inspector. The earlier visual-first behaviour is kept behind `--mode visual-first` because it's still an open question which gives better reviews. This is an experiment, not a conclusion, so don't remove either mode without comparing them on real PRs.

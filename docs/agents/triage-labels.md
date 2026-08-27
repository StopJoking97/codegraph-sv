# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## Repo state

All five exist on `StopJoking97/codegraph-sv`. `wontfix` shipped with the repo; the other four were
created during setup.

Verify with:

```bash
gh label list --repo StopJoking97/codegraph-sv --json name --jq '[.[].name]|join(", ")'
```

## Not triage labels

`codegraph-sv` also carries GitHub's default set — `accessibility`, `bug`, `documentation`,
`duplicate`, `enhancement`, `good first issue`, `help wanted`, `invalid`, `question`. These are
ordinary topic labels, **not** triage roles, and are deliberately left out of the table above. Do
not treat `enhancement` as `ready-for-agent` or `question` as `needs-info` — a triage role means the
issue is in a particular state in the workflow, which is a different claim from what the issue is
about. An issue can carry one label from each set.

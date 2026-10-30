# Issue tracker: GitHub (draft-first)

Issues and specs for this repo live in **`StopJoking97/codegraph-sv`**. Every ticket is
DRAFTED locally under `.scratch/` and published only after the user reviews it.

## ⚠️ Always pass `--repo` explicitly

This clone has two remotes and `origin` is **not** ours:

| Remote   | Repo                          | Ours? |
| -------- | ----------------------------- | ----- |
| `origin` | `colbymchenry/codegraph`      | **No — upstream** |
| `sv`     | `StopJoking97/codegraph-sv`   | Yes   |

`gh` infers the repo from `origin` when `--repo` is omitted, so a bare `gh issue create` targets
**upstream**. The standing owner ruling is: no upstream PR, no upstream issue.

```bash
gh issue create --repo StopJoking97/codegraph-sv ...   # ✅ correct
gh issue create ...                                    # ❌ targets colbymchenry/codegraph
```

Treat a missing `--repo` as a bug in the command, not a convenience.

## The draft-first flow

1. **DRAFT** — write `.scratch/<feature>/NN-<slug>.md`. Nothing leaves the machine.
2. **REVIEW** — present the draft set. The user approves per-ticket or as a batch.
3. **PUBLISH** — `gh issue create --repo StopJoking97/codegraph-sv --title "..." --body "..." --label ready-for-agent`,
   then record the returned issue number back into the draft file so the two stay linked.

A skill instructed to "publish to the issue tracker" performs stages 1 and 2 **and stops**. Stage 3
requires explicit approval. Never publish an unreviewed draft.

`.scratch/` is gitignored — drafts are working artifacts, not repo history. Once published, the
GitHub issue is the record.

## Conventions

All commands take `--repo StopJoking97/codegraph-sv`.

- **Create an issue**: `gh issue create --repo StopJoking97/codegraph-sv --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --repo StopJoking97/codegraph-sv --comments`.
- **List issues**: `gh issue list --repo StopJoking97/codegraph-sv --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment**: `gh issue comment <number> --repo StopJoking97/codegraph-sv --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --repo StopJoking97/codegraph-sv --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --repo StopJoking97/codegraph-sv --comment "..."`

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr`
equivalents — `gh pr view`, `gh pr diff`, `gh pr list`, `gh pr comment`, `gh pr edit --add-label`,
`gh pr close` — each with `--repo StopJoking97/codegraph-sv`. For triage, filter
`gh pr list --json number,title,body,labels,author,authorAssociation,comments` down to
`authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either — resolve with
`gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Draft under `.scratch/`, present for review, and stop. Publish to
`StopJoking97/codegraph-sv` only once approved.

## When a skill says "fetch the relevant ticket"

Prefer the local draft under `.scratch/`. If the draft records an issue number, also run
`gh issue view <number> --repo StopJoking97/codegraph-sv --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets. Every command
below takes `--repo StopJoking97/codegraph-sv`.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --repo StopJoking97/codegraph-sv --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies**. Add an edge with `gh api --method POST repos/StopJoking97/codegraph-sv/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/StopJoking97/codegraph-sv/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children, drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --repo StopJoking97/codegraph-sv --add-assignee @me` — the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer to the map's Decisions-so-far.

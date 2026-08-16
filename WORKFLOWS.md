# Workflow roster

Workflows Mikael plans to write for himself. They are personal definitions (`~/.wa/workflows/`) or repo definitions, never shipped defaults. The shipped set lives in `.specs/30-defaults.md`.

## Workflows

- `extended-ticket`: the full pipeline, built on the default `ticket`:
  - Triage classifies type, priority, complexity, and affected area, and stops with a gate when the item is not actionable.
  - A split decision breaks a large item into smaller tickets, files them with `gh`, and stops. Each new ticket gets its own run when started.
  - The plan ends in acceptance criteria that the reviewer judges verbatim.
  - Implement dispatches to a per-change-type skill and can fan work out across parallel implement steps.
  - User-facing changes produce a QA walkthrough artifact for a human tester.
  - Each review result feeds into the next round as input: verify prior findings, catch what the last round missed, detect fix-the-fix loops, and make scope calls that spawn follow-up tickets. The previous result is a variable in the run function, so it needs no store.
  - A retro step at the end proposes workflow edits from the diff between plan and outcome.
- `migrate-page`: a short-lived repo workflow: move one page from Angular to React, with its checklist skill.

## Skills

A per-change-type craft set for `extended-ticket` implement: user-facing, data and backend, integrations and platform, quality and internals, ops and meta.

# penguin

Read `.specs/` before any work. It is the source of truth:

- `.specs/00-product.md`: what penguin is, principles, glossary.
- `.specs/10-workflow-model.md`: params, the ctx API, sessions, messages, composition.
- `.specs/20-architecture.md`: components, storage, run lifecycle, commands, invariants.
- `.specs/30-defaults.md`: the example catalog.

The specs describe the present system, and only the present system. They contain no milestones, phases, build order, history, rejected alternatives, or notes about what changed. When a decision changes, rewrite the spec text as if the new form was always the design. Past decisions live in git history.

## Conventions

- Every engine invariant in `20-architecture.md` is pinned by a test. A change that touches one updates its test.
- Spec and code move together: a behavior change lands with its spec edit in the same commit.
- Quality gates for every change: `tsc --noEmit` and the test suite (`bun test`) pass.
- Personal workflow ideas go in `WORKFLOWS.md`, not in the specs.

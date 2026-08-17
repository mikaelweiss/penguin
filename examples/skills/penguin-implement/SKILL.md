---
name: penguin-implement
description: Builds the change a plan describes, with its tests and quality gates. Use when a plan is approved and the code must be written.
---

# Implement the plan

Build the change in the plan. The input is the plan itself.

1. Read the files the plan names before you edit them.
2. Make the change. Match the style of the code around it.
3. Add or update the tests the plan calls for. One test per invariant.
4. Run the repository quality gates: the type check, the linter, and the test suite.
5. Fix what fails. Do not leave a gate red.
6. Commit the work with one message in the repository style.

Stay inside the plan. Raise anything else in the commit body.

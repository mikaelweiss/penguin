---
name: implement
description: Builds the change a plan describes, with its tests. Use when a plan is approved and the code must be written.
---

# Implement the plan

Build the change in the plan. The input is the plan itself, and it may also name the files this task works in, how the code stands there, what the gates said before this change, what they said after your last turn, and the blocking findings of the last round.

A `# The files this task works in` section is a scout's reading of the repository, done before you opened. Start from that list rather than searching for the same paths again: finding them has already been paid for once, and doing it again is the most expensive habit a session has. Search only for what the list does not cover, and only after you have read it.

1. Read the files the list and the plan name before you edit them.
2. Make the change. Match the style of the code around it.
3. Add or update the tests the plan calls for. One test per invariant.
4. Fix every gate the input names as red.
5. Commit the work with one message in the repository style.

Stay inside the plan. Raise anything else in the commit body.

## The gates

penguin runs the quality gates after your turn and hands you their output at the top of the next one. Do not run them yourself. Do not go looking for the commands, and do not run the whole test suite to see where you stand.

While you fix one failing test, run that test alone. That is the only gate command worth your turn.

A failure the input's baseline already names was there before you started. Leave it. Fix what this change breaks.

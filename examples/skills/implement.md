# Implement the plan

Build the change in the plan. The input is the plan file path.

1. Read the plan.
2. Read the files it names before you edit them.
3. Make the change. Match the style of the code around it.
4. Add or update the tests the plan calls for. One test per invariant.
5. Run the repository quality gates: the type check, the linter, and the test suite.
6. Fix what fails. Do not leave a gate red.
7. Commit the work with one message in the repository style.

Stay inside the plan. Raise anything else in the commit body.

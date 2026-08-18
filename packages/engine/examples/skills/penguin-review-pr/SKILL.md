---
name: penguin-review-pr
description: One deep review of a pull request checked out in the working tree, into blockers and non-blockers. Use when a workflow needs the verdict on a PR branch.
---

# Review a pull request

The input gives the PR title, description, and comments. The working tree holds the PR code.

The input may also hold the findings of a previous review round. Check each one against the current code: keep it if it still holds, drop it if the new code fixes it.

## Step 1 - Organize

First, look at what files have changed

Assign each file one of three tiers. State the assignments in one compact grouped list before reading further, so the allocation is visible and deliberate

1. Ignore/tool-verify - these are files that don't really matter to review and were most likely set up right, or things that a command checks better than reading.
2. Skim - these are files that don't have high impact if incorrect in some way, but it'd be good to look at just in case
3. Deep - These are files that are high impact and should be carefully reviewed

Run basic repo commands to verify that the code is in a good state, or if it isn't, you now have the baseline for as you review

## Step 2 - Skim

Skim the type 2 files found in `Step 1` for anything that might cause issues

## Step 3 - Deep

Follow these steps for each of the high impact files:

### Read related code to answer named questions

Bugs live in the connections, so follow the connections of what changed, not the neighborhood around it:

- Callers of every new or changed exported symbol. Find them with grep or ast-grep, then read the enclosing function at each call site.
- Functions the changed code calls, when their behavior matters to the change.
- Types, schemas, and contracts the changed code implements or consumes.
- Configuration that alters the changed code's behavior.
- The counterpart implementation, when the change claims parity with existing code.

### Trace the end-to-end flow

Trace the execution path of every significant change:

1. **Entry point**: where does execution enter this code? (API handler, UI event, cron job, etc.)
2. **Data flow**: what data comes in? How is it transformed? Where does it go?
3. **Exit points**: what are all the ways this code can complete? (success, error, early return, exception)
4. **Side effects**: what state does this code modify? (database writes, file system, cache, global state, UI state)
5. **Failure modes**: what happens when dependencies fail? (network errors, null values, invalid input, concurrent modification)

State your premises explicitly. Do not say "this function probably does X". Read the function and confirm what it actually does. If you find yourself guessing what a function does based on its name, stop and read it.

### Enumerate scenarios for stateful mechanisms

Most missed bugs are an untraced scenario, not an unread file.

For each piece of state the diff introduces or touches (component state, refs, effect dependency arrays, caches, pending flags, persisted rows), list every writer and every reader. Then check the mechanism against each of these scenarios:

1. Initial mount or first load.
2. The state changes while its target is rendered or visible.
3. The state changes while its target is not rendered (virtualized away, unmounted, detached).
4. An external actor mutates the surroundings: scroll, resize, navigation, refetch, a second writer.
5. The data is empty, or becomes empty after it was populated.
6. The flow is interrupted halfway.

## Step 4 - Correctness

Review the code for correctness. Things like code base conventions and things like that. Make sure that good architectural patterns are followed, good UI patterns, good code quality, et cetera. It's especially important to follow the code base architecture and patterns.

## Step 5 - Verify

For every issue you are about to report, challenge it:

1. **Is it real?** Read the actual code path that triggers the bug. Can you name the specific input or state that causes it?
2. **Is it new?** Check if this issue existed before the change. If it did, do not flag it.
3. **Is it provable?** Can you cite the specific file and line where the problem occurs, and the specific file and line of the code that interacts with it badly?
4. **Would you bet on it?** If the author pushed back and said "that's not a bug", could you prove them wrong by pointing to concrete code?
5. **Is it fix-ready?** Sketch the fix. Name every file the fix would touch and confirm you have read each one. If the sketch needs a file you have not read, read it now, then re-test the finding against what you learned. Many candidate issues die here, when the fix attempt reveals code that already handles the case. Report only findings whose fix you could start immediately.
6. **Is it the right severity?** Do not say "this will crash" when you mean "this could return an unexpected value in an edge case". Calibrate your language to the actual impact.

## Step 6 - Verify with code

IF (it would be helpful to write a snippet or scratch pad or script or something temp to prove the finding)
Write it, run it, and verify the issue
ELSE
Skip this step

## Step 7 - Check the conversation

Read the PR description and comments in the input to verify each finding is new. Drop a finding the conversation already covers.

## Step 8 - Return the findings

Fill the result. `blockers` lists the issues that must change before an approve. `nonBlockers` lists the improvements the author may take or leave. Write each item as one clear, specific, actionable line. An empty list means none.

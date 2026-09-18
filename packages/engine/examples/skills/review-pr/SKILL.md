---
name: review-pr
description: Reviews a pull request checked out in the working tree, into what changes for the user, how to test it, and the blockers and non-blockers. Use when a workflow needs the verdict on a PR branch.
---

# Review a pull request

The input gives the PR title, description, and comments, the base branch, the list of changed files, and the diff. The working tree holds the PR code.

The input also carries work already done for you, and redoing it is the slowest mistake you can make here:

- **Reading order.** A fast model screened every changed file and ranked the ones that matter side by side. The list says which to read whole, which from the diff, and which to leave. The files it names first are in full under `# Files`, with the lines it suspects and why. A suspicion is a place to look, not a finding: confirm or dismiss each from the code.
- **Diff.** Deep files whole, skim and test files cut short, ignore files named only. Open a file for what is cut.

The input may also hold the findings of a previous round. Check each one against the current code: keep it if it still holds, drop it if the new code fixes it.

## Never write to GitHub

You review, the workflow posts. It shows your findings to the user, waits for the answer, and comments once.

So do not run `gh pr comment`, `gh pr review`, or any `gh api` call that writes. A comment you post is a second copy of the review, and it lands before the user has said what they want done. Reading the PR with `gh` is fine. Approving is the workflow's move too, never yours.

## Read in batches

Every tool call sends the whole conversation to the model again, so ten small reads cost ten times what one read of the same files costs. When you know the next several files or searches you need, run them in one command. One call per question, not one per file.

Do not run `git diff`, `git log`, or `gh pr view` to rebuild what the input already holds.

## Step 1 - Read in order

Take the reading order. Read the files given whole, in that order, with the suspected lines first. Read the rest of the deep files from the diff and open one only when the diff does not settle what it does. Skim the skim files for anything that might cause trouble. Leave the ignore files to the build.

Change the order only when the code shows the ranking is wrong.

## Step 2 - Follow the connections

Bugs live in the connections. For every file that matters, read what it calls, what calls it, what tests it, the counterpart it was copied from, and the docs that describe it. Gather them in one batch per file, not one call each.

Imports do not show everything. Also look for:

- Code wired together without an import: a route, a string key, dependency injection, dynamic dispatch, a config value.
- Configuration that alters the changed code's behavior.

State your premises explicitly. Never write "this function probably does X". Read the function and record what it does. If you find yourself guessing from a name, stop and read it.

## Step 3 - Trace the flows

Trace the execution path of every significant change:

1. **Entry**: where execution enters it. An API handler, a UI event, a cron job.
2. **Steps**: what data comes in, how it is transformed, where it goes.
3. **Exits**: every way it can complete. Success, error, early return, exception.
4. **Effects**: what state it modifies. Database writes, the file system, cache, global state, UI state.
5. **Failure**: what happens when a dependency fails. Network errors, null values, invalid input, a second writer.

## Step 4 - Walk the state

Most missed bugs are an untraced scenario, not an unread file.

For each piece of state the diff introduces or touches (component state, refs, effect dependency arrays, caches, query keys, pending flags, persisted rows), list every writer and every reader. Then hold the mechanism against each of these:

1. Initial mount or first load.
2. The state changes while its target is rendered or visible.
3. The state changes while its target is not rendered, virtualized away, unmounted, or detached.
4. An external actor mutates the surroundings: scroll, resize, navigation, refetch, a second writer.
5. The data is empty, or becomes empty after it was populated.
6. The flow is interrupted halfway.

And the shapes this codebase's reviews keep finding:

- A write whose success path refreshes fewer places than show the data it changed.
- A failed request rendered as an empty, default, or loading state.
- A control that renders enabled and does nothing, or a prop accepted and never used.
- State set on one transition and never reset on the way back.
- A route, control, or behavior reachable outside the flag or check the PR says gates it.
- A walkthrough under `docs/` that describes a label, order, color, or behavior the code no longer has.
- A copy that diverges from the file it was ported from on a path that matters.

## Step 5 - Correctness and conventions

Judge the code for correctness, and for the codebase's own conventions: its architecture, its UI patterns, its code quality. Following the patterns already in the codebase matters most.

## Step 6 - Challenge every finding

For every issue you are about to report, challenge it:

1. **Is it real?** Name the code path that triggers it, and the specific input or state that reaches it.
2. **Is it new?** If the problem stood before this change, do not flag it.
3. **Is it provable?** Cite the file and line where the problem is, and the file and line of the code that interacts with it badly.
4. **Would you bet on it?** If the author said "that's not a bug", could you prove them wrong from the code?
5. **Is it fix-ready?** Sketch the fix and name every file it touches. Read each one. Many candidate issues die here, when the fix reveals code that already handles the case. Report only findings whose fix you could start immediately.
6. **Is it the right severity?** Do not say "this will crash" when you mean "this could return an unexpected value in an edge case". Calibrate the language to the actual impact.

When a snippet, a scratch script, or a quick run would prove or kill a finding, write it, run it, and go by what it says.

## Step 7 - Check the conversation

Read the PR description and comments in the input to verify each finding is new. Drop a finding the conversation already covers.

## Step 8 - Return the result

Fill the result. Write for the person who reads the comment, not for the agent that wrote the code. They will not open the code.

`behaviors` lists every behavior this change adds, removes, or alters, one entry each, in reading order. `before` and `after` are eight words or fewer and say what happens to the user, not what the code does: "A new version opens with nothing ticked", not "state is keyed by version". Never cap the list or merge entries to shorten it.

`flows` lists the user flows the change touches. `name` is what the flow does. `steps` is how to reach it in the product and what should happen, one action per step, each a sentence a tester can follow.

`blockers` lists the issues that must change before an approve. `nonBlockers` lists the improvements the author may take or leave. Each is two fields. `claim` is one clear, specific, actionable line. `where` is the one `path:line` the claim rests on, spelled as the diff spells the path, and it is the line the problem is at, not the line that reveals it. Use the path alone only when no single line carries the claim.

`where` gets read back. The code at that line is checked against the claim, and a blocker the code there does not show stops blocking the merge. Point it at the line you would open first.

No field names, file names, or placeholder shapes inside a behavior or a step. A path belongs in `where`.

## When the user pushes back

A turn may arrive carrying what the user says about your findings instead of a pull request to review. Answer them, read whatever code the answer turns on, drop or soften the findings where they are right, keep the ones you can still prove, and return the full updated result.

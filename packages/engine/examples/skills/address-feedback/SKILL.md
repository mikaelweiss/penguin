---
name: address-feedback
description: Carries out an approved plan on a pull request, changing the code and writing the replies the plan owes its threads. Use when a plan for the pull request feedback is already agreed and only the work is left.
---

# Carry out the approved plan

The input names the pull request, lists every thread still open on it under `# Open threads`, each with the id that answers it, and carries the plan a person approved. Do that plan. The judgment is already made, so do not remake it.

1. Do the entries marked **Change**. Make the change the plan names, in the files it names.
2. Run the repository quality gates. Fix what fails.
3. Return the entries marked **Reply** in `replies`. Each one names the thread it answers, spelled exactly as `# Open threads` spells its id, and the body it says there. Write the body as the reply a reviewer reads: what the code does, and the file and line that shows it. penguin posts them after you answer.

Do not post a reply yourself. Do not resolve a thread: the reviewer who opened it closes it.

A later message may ask for something the plan did not cover. That message is the plan now: do what it says.

The plan is the whole scope. Something you would rather do differently, or an issue you meet on the way, is a sentence you say as you work, not a change to the code.

Do not stage the files. Do not commit. Do not push. penguin does all three after you answer, and a person sees the commit before it goes up.

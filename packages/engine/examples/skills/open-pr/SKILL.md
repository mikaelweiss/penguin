---
name: open-pr
description: Writes the pull request title and body for the branch, from the commits and the diff in the prompt. Use before a pull request opens, when the description has to say what the branch changes and why.
---

# Write the pull request

The branch is below: the base it lands on, the subjects of the commits it holds over that base, the diff stat, the diff itself, and the newest merged titles. A `# Ticket` section, when present, names the issue this branch is for. A diff that ends at a `cut here` line was too large to send whole, and the stat above it is the whole change. That is everything the description needs. Run no commands. Do not create the pull request. Do not push. penguin does both after you answer.

1. Write `title`: what the branch does, in the style of the merged titles above: their prefix convention, their mood, their length. One line under 70 characters. An issue id in those titles belongs to other work, so never copy one. When the prompt holds a `# Ticket` section, place its id where the titles above place theirs. Without one, write the title with no id.
2. Write `body`: why the change is right, and what a reviewer should read first. A few short paragraphs at most. A branch whose title says it all takes an empty body.

The commits already say what changed. The body says why. Never list the files or the commits.

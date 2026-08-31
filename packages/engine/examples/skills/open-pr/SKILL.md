---
name: open-pr
description: Writes the pull request title and body for the branch, from its commits and its diff against the base. Use before a pull request opens, when the description has to say what the branch changes and why.
---

# Write the pull request

Write the title and the body for this branch's pull request. Do not create it. Do not push. penguin does both after you answer.

1. Read the base branch off the prompt, under `# Base branch`. A `# Ticket` section, when present, names the issue this branch is for.
2. Read the work: `git log origin/<base>..HEAD --oneline`, then `git diff origin/<base>...HEAD --stat`, and the diff itself where the stat leaves a change unclear.
3. Read the last twenty merged titles: `gh pr list --state merged --limit 20 --json title -q '.[].title'`. They are the style to match.
4. Write the title: what the branch does, in that style, one line under 70 characters. An issue id in those titles belongs to other work, so never copy one. When the prompt holds a `# Ticket` section, place its id where the titles above place theirs. Without one, write the title with no id.
5. Write the body: why the change is right, and what a reviewer should read first. A few short paragraphs at most. A branch whose title says it all takes an empty body.
6. Put them in `title` and `body`.

The commits already say what changed. The body says why. Never list the files or the commits.

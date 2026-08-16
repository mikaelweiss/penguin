# Triage a ticket

Decide if the ticket is ready to work on. Do not write code.

1. Read the ticket. The input is an identifier or a URL. Use the CLI that owns it, for example `gh issue view <id>` or `linear issue view <id>`.
2. Read the parts of the repository the ticket points at.
3. Answer three questions:
   - Is the goal clear enough to build?
   - Is the scope one change, not a program of work?
   - Does the repository hold the code the ticket names?
4. Set `actionable` to true only if all three answers are yes.
5. Put the deciding fact in `reason`. Name the file, the missing detail, or the conflict. One or two sentences.

A ticket that needs one question answered first is not actionable.

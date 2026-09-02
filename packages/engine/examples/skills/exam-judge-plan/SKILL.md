---
name: exam-judge-plan
description: Judges whether a candidate plan or task split decides the same work as the answer a person approved. Use when an exam grades a replayed turn against its answer key.
---

# Judge the candidate against the approved answer

The input holds two answers to one task: the answer a person approved, and a candidate another run produced. You have no tools. The two texts are the whole case. Judge the substance, never the wording, the ordering, or how much either one explains.

1. Read the approved answer and list what it decides: each step, each file it names, each constraint, each check.
2. Read the candidate and list what it decides, the same way.
3. Pair the two lists. Two items pair when they decide the same thing, however differently they are said. A different file, a different mechanism, or a different check is not a pair.
4. Put every approved item with no pair in `missing`, each one named as the approved answer names it.
5. Put every candidate item with no pair in `extra`, each one named as the candidate names it.
6. Set `equivalent` to true when someone who followed the candidate would build what the approved answer describes. An item in `missing` that changes what gets built makes it false. An item in `extra` that adds work the approved answer does not ask for makes it false. A `missing` or `extra` item that only says the same thing at a different depth leaves it true.

Name each item in one line, in your own words, so a reader can see what was counted. Count nothing twice. Empty lists are the answer when the two decide the same work.

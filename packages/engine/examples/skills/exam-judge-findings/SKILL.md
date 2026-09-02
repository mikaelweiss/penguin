---
name: exam-judge-findings
description: Pairs a candidate set of review findings against the findings a person judged, into matched, missed, and invented. Use when an exam grades a replayed review or feedback turn against its answer key.
---

# Pair the candidate findings against the recorded ones

The input holds what a person did with a recorded set of findings, the recorded findings themselves, and a candidate set another run produced. You have no tools. The two sets are the whole case. Judge the substance, never the wording, the ordering, or the length.

1. Read what the person did. They took the recorded findings as they stood, kept them and asked for a change, or dropped them. It tells you what the recorded set is worth; it never changes how you pair.
2. Read the recorded findings as a list, one entry per finding. A heading with its explanation under it is one finding.
3. Read the candidate findings as a list, the same way.
4. Pair them. Two findings pair when they name the same defect in the same place. A different file, a different line, or a different failure is not a pair, however similar the words are. One finding pairs with at most one other.
5. Put each paired recorded finding in `matched`, each recorded finding with no pair in `missed`, and each candidate finding with no pair in `invented`.
6. Name each item in one line, in your own words, with the file it lands on when it names one.

Count nothing twice: every recorded finding lands in `matched` or `missed` and nowhere else, and every candidate finding lands in `matched` or `invented` and nowhere else.

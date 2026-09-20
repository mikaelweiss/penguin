# The goal

## The root of it

You want a business that runs without you and that you still own.

"Workflows" and "agents" are mechanisms. The thing itself is a delegation
system. Its scarce resource is your attention. Its output is decisions made
correctly without you. Its two failure modes are a decision that reached you
when it should not have, and a decision made without you when it should have
come to you. Everything else (models, processes, machines, adapters) exists to
move those two numbers.

## Why you need it

Time. The side business gets the hours after work, and not many of them. A
business is a set of processes that must keep running whether or not anyone is
looking. A process that needs you to start it, step it forward, or babysit it
is not a process, it is a chore, and chores are exactly what you do not have
time for. The only way the business exists at all is if the system carries it
between the moments you can look.

## Why build it rather than buy it

Every existing tool is built around interaction. Chat, DMs, notifications,
"your agent has a question". They optimize for engagement, and engagement is
the cost you are trying to eliminate. They put the human in-band. You want the
inverse: a system whose default is that nothing reaches you, and whose asks are
rare, ranked, batched, and come with a recommendation and a default.

You also learned two things from v1 that no product is built on yet:

- Prose cannot be trusted for control flow. A script can. So processes must be
  executed by a runtime, not followed by a model.
- Most noise comes from using the wrong kind of intelligence for a step. Using
  a reasoning model to route an email, or asking a person to confirm what a
  classifier could decide with 95% confidence, is where "needy" comes from.

And the README's line still holds: there are many factories, but this one is
yours. You decide the processes, the policies, and the line between what the
system does alone and what it brings to you.

## What it is, said once

An operating system for a one-person business.

- **Roles**: who does the work. Employees with a charter, tools, a machine, an
  identity, a budget, and a policy.
- **Processes**: how the work is done. Deterministic, readable, composable,
  written by describing them in conversation.
- **Events**: when things happen. Time, the outside world, and the system's
  own state changes. Processes wake on events; nothing polls, nothing holds a
  thread.
- **Policy**: what a role may decide alone, what it must escalate, what the
  default is if you do not answer, and by when.
- **Memory**: what the business knows. Readable by every role, written by
  processes, versioned.
- **Machines**: where work happens. A role's own computer, not yours.
- **One inbox**: you. Everything that needs a person lands in one ranked queue
  with a recommendation attached.

## What "just works" actually means

1. You describe a process in conversation, in your words.
2. The system turns it into something deterministic and short enough to read
   on one screen, and shows it to you once.
3. It runs on its own, on triggers you did not have to think about.
4. It comes to you only under the policy you set, with a recommendation and a
   default, and it batches unless something is urgent.
5. You can audit any decision after the fact: what was seen, what was decided,
   by what, and why.
6. You change it by talking, not by editing code.

## The balance: four kinds of decision

This is the "automate what can be automated, use AI where it makes sense" idea
made precise. Every step in every process is exactly one of these.

| Kind | When | Who | Cost |
| --- | --- | --- | --- |
| Script | The output is computable from the inputs | Code | Free |
| Judge | The options are known, the answer needs reading | System One model (Jev) | Milliseconds, fractions of a cent |
| Work | The output is an artifact: code, a document, a test run, research | System Two agent on a machine | Minutes, dollars |
| Person | Taste, values, money, irreversible actions, or whatever policy says | You | Your attention |

Most of the noise in existing tools is a Work step where a Judge belongs, or a
Person step where a Judge belongs. Most of the fragility in v1 is a Script step
written as prose, or a Person step with no policy behind it. The rule for
placing a step is mechanical:

- Can code compute it? Script.
- Can you list the possible answers up front? Judge.
- Does it produce something new? Work.
- Is it irreversible, about money, or about what the business stands for? Person,
  under policy, with a default.

A System One model matters here for a reason beyond speed. It returns a
calibrated probability, so the system can act when confidence is high, escalate
when it is low, and log both. That is what turns "decide or ask" from a
hard-coded choice into a policy you can tune.

## What it is not

- Not a chat app. Conversation is how you author and how you answer, not how
  work happens.
- Not an IDE. Watching an agent work is a cost, not a feature.
- Not a coding tool. Software delivery is one process among many.
- Not a general workflow builder in the n8n or Zapier sense. Those are
  script-only, with no judge, no work, and no person anywhere.
- Not an "AI employee" that messages you. Employees that message you are the
  problem.

## How you know it is working

- Minutes of your attention per week, trending down.
- Fraction of asks that were necessary (you would not have wanted it decided
  without you), trending up.
- Fraction of autonomous decisions you later reversed, trending down.
- Time from "describe a process" to "it ran once", in minutes.
- Cost per process per week, bounded.

If a feature does not move one of these, it does not belong in v2.

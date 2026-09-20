# The core issue

## v1 is a machine for executing procedures under supervision

Strip away the workflows, adapters, run files, and the desktop, and what v1
does is this: a person starts a procedure, watches it, answers it, and reads
what it produced. It is very good at that. Every part of it, from `view.ask`
to the transcript to the terminal panel, is built to make supervised
execution smooth.

What you want is the opposite product: something that holds a
responsibility without being supervised. Those are not two versions of one
thing. A supervised procedure runner gets worse as you add autonomy, because
everything it does to keep you informed and in control becomes an
interruption. That is the "needy" feeling. It is not a bug in the
workflows. It is the product working as designed, pointed at a job it was
not designed for.

## Procedures hold the how, and nothing holds the why

A v1 workflow is a procedure: fetch the PR, run the reviewer, post the
findings, wait for a push. Nowhere in the system is the goal the procedure
serves. Nothing knows that a review exists so that bad code does not merge,
or that a QA pass exists so that customers do not hit regressions, or what
the business is trying to be.

Without a goal, the system has no basis for any decision the procedure did
not anticipate, so every unanticipated situation becomes a question to you
or a new branch in the code. That is where the weeks went. Each tweak to
`review-pr` was a case that the goal would have resolved in one sentence and
the procedure needed forty lines to cover. Procedures grow without bound
when they are the only carrier of judgment. Goals are compact because they
delegate the cases.

The tension you named is real: prose is unreliable, scripts are rigid. The
resolution is not to pick one. It is that scripts should be small and few,
holding only the parts where order and completeness are non-negotiable, and
goals should carry everything else. v1 has it backwards: large scripts,
no goals.

## Every interaction is a task, so nothing accumulates

A person you delegate to gets better over months because context, trust,
and taste accumulate in them. Each v1 run starts from nothing but its
params and a skill file. Nothing learns what the project is, what you
decided last time, what you care about, or what went wrong before. Every
run is a new contractor reading the brief for the first time.

This is why two in-flight tasks feel like a lot. Each one is an open loop
that only you can close, because nothing else holds enough context to close
it. Delegation only reduces load when the delegate closes loops. v1 opens
them and hands them back.

## The person is asked for permission instead of shown results

Every ask in v1 is a request for permission before acting. That is the
posture of a tool. The posture of a trusted delegate is the reverse: act
within the boundary, report after, and leave a window to reverse. A good
employee does not ask whether to use tabs or spaces. They decide, mention
it in the weekly summary, and change it if you object.

Permission-first is also why supervision does not scale. Permission has to
be given per action, in the moment, with context loaded. Review can happen
in a batch, at a time you choose, sampling what matters. v1 has no notion
of review at all. Its only feedback channel is the ask.

## The system is not self-sufficient

Runs use your machine, your git identity, your GitHub login, your agent CLI
subscription, and your open laptop. That is fine for a tool you hold in
your hand. A thing that is supposed to work while you sleep cannot borrow
your hands to do it. Self-sufficiency is not only about compute. It is
identity, credentials, tools, and information. Anything the agent has to
come to you for is a loop opened.

## Things worth noticing that were not in the blurb

- **Trust is the product.** Autonomy without a way to calibrate trust is
  either dangerous or useless. The thing that lets a person hand off more
  over time is a visible track record per agent per kind of action, and a
  dial they can turn. Nothing in v1 has a track record.
- **Reversibility, not domain, should set the autonomy level.** Drafting a
  post is free to get wrong. Sending it is not. Shipping a build is not.
  Autonomy should be widest where mistakes are cheap to undo, and the
  system should know which is which.
- **Goals need a signal.** "Grow downloads" is only delegable if the agent
  can see downloads. Where there is no metric, the agent has to produce
  evidence and the person has to judge it periodically. Many business
  goals are like this, and a system that only works with clean metrics
  will only run the easy parts.
- **Long-running agents drift.** Memory grows, instructions rot, a
  workaround becomes a habit. A person's periodic review is where drift is
  caught, so the review has to be designed to catch it, not just to report.
- **Shared context is most of "it just works."** Explaining a process in
  one paragraph only works if the system already knows the business, the
  products, the tools, the accounts, and the quality bar. That onboarding
  is a one-time cost that v1 never pays and every run re-pays badly.
- **You will stop understanding your own business** if the digest only
  reports. It has to teach: what changed, why, what the agent noticed. The
  aim is leverage, not absence.
- **Attention should be a ritual, not a stream.** Businesses run on
  cadences. The person's involvement should be a scheduled review, weekly
  or daily, with an urgent channel that is almost never used. Any design
  that assumes interrupts will feel needy no matter how few there are.
- **The system should be able to operate itself.** If every part is
  reachable by an agent, then an agent can set up a new agent, adjust a
  procedure, or fix its own tooling. That is the step that turns a set of
  automations into something that grows.

## What v1 proved

That deterministic bridges to the world, typed results from agents, faults
as gates, and a person in the loop can be made to work together reliably.
That was the hard mechanical half and it holds up. The half that is
missing is not mechanical. It is the operating model: goals, accumulation,
trust, review, and self-sufficiency.

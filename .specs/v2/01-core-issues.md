# Penguin v1: the core issue

## In one sentence

In v1 the process is a program and you are a subroutine of it.

A workflow is a TypeScript function whose control flow *is* the process. Every
process has to be written by a programmer. Every reaction to the world has to be
hand-written as a loop inside `run()`. Every judgement the code cannot make
becomes a `view.ask` that parks a thread until you answer. The unit of the whole
system is a run: something a person starts, that lives exactly as long as its OS
process, and that ends when the function returns. Nothing exists between runs.
There is no place where the business, its roles, its events, its knowledge, or
its policies live.

That shape is right for "help me with this ticket right now". It is the wrong
shape for "run this without me". Autonomy, state, and low noise are not features
you can add to it. They are the shape, and the shape has to change.

## What the code shows

Everything below is observable in the repo today.

**Reacting to the world means building a reactor by hand.** `open-pr.ts` is 531
lines. Roughly 200 of them are a home-made event loop: a `poke`/`wait`/`pending`
wake mechanism, a `closed` promise every gate races against, a per-base watcher
that retires itself on retarget, a pump over `view.listen()`, a pump over
`github.pr.changes()`. `gh.ts` implements `changes()` by polling every 30 seconds
and diffing two snapshots. The engine has no concept of an event, so the one
workflow that needs to react to a PR had to invent events inside itself. Every
future process that reacts to anything would do the same.

**"Always on" is a `for (;;)` inside a run.** `pr-queue.ts` is the only
long-lived thing, and it is a run that never returns. It dies with its process.
Whether it is alive is guessed by `lib.rs` reading pid files, sniffing `argv`
for the run id, and checking for zombies. There is no scheduler, no trigger, no
schedule, no webhook anywhere in `packages/engine`. The word "cron" does not
appear.

**The only escalation primitive is a blocking question.** There are 25
`view.ask` calls across the example workflows. `work.ts` asks up to four times
per task: approve the gates, acknowledge a non-actionable ticket, acknowledge a
failed review, and "try it" after every task. `plan.ts` asks five ways. An ask
has no priority, no default, no deadline, no batching, and no policy behind it.
"Needs you" in the desktop is a boolean on a run. This is exactly the "needy"
property, and it is structural: the code either hard-codes a decision or asks
you. There is no third option, and the third option is the whole product.

**Craft is spread over four layers, and every change touches all four.** 18
workflows (about 3,900 lines), 12 adapters (`jev.ts` alone is 1,396 lines with a
1,042-line helper), a `helpers/` folder (about 2,700 lines), and 18 skills.
"How we review a PR" lives in `review-pr.ts` (533 lines), the `review-pr` skill,
the Jev adapter, the Jev helper, and the brief helper. That is why weeks went
into tweaking.

**Prose is hidden inside code.** `brief()` in `implement.ts`, the `work` array
in `open-pr.ts`, `checklist()` in `review.ts`, `fence()` in `plan.ts`: markdown
assembled by string concatenation in TypeScript. This is the worst of both
worlds. It is prose, so it cannot be verified, and it is code, so it cannot be
read or edited by anyone but a programmer. The repo's own README says "you're
stuck describing logic in prose" is a flaw of other tools; v1 moved the prose
into template strings.

**Jev is used in the right places and kept in the wrong one.** Ticket triage,
PR triage, feedback triage, diff screening, claim checking: all correct uses of
a System One model. But every question is a hand-written TypeScript object, and
the only home a judgement can have is the adapter file. 2,400 lines to ask about
twenty questions. A new judgement means a new adapter method.

**One person, one machine, one checkout.** `paths.ts` roots everything in
`~/.penguin` and `~/.local/state/penguin`. Runs are keyed by `cwd`. Secrets are
in the Bun keychain. Agents are CLIs on `PATH`, and there are six adapters
(250 to 435 lines each) that parse six stream formats. Nothing in the system can
run anywhere except your laptop, as you, in your checkout. An agent that needs
its own computer, its own GitHub identity, or its own working hours has no way
to exist.

**There is no memory.** The run file remembers a run. An adapter has a `state`
folder. Nothing remembers the business: what it is, what happened last week,
who the customers are, what was decided and why. Workflows are reconcilers of
the world, which is a good stance, but the only world they can re-read is git
and GitHub.

**The CLI is not an interface.** `examples/run.ts` runs one workflow in the
foreground. There is no way from a shell to list runs, answer an ask, send a
message, read a transcript, or stop a run. The desktop is the only complete
client. The de facto API is the run-file format on disk.

**The catalog is entirely about code.** vcs, github, jira, gates, brief, six
agent CLIs, jev. The abstractions are general. The content is not.

## Issues you did not name

1. **The desktop is becoming an IDE.** File browser, terminal, browser panel,
   diff and review panels, and `.specs/file-browser.md` ports opencode's side
   panel wholesale. Every one of those is a surface for *watching* work. That is
   attention spent on supervision, the opposite of leverage. The desktop should
   be an inbox and a dashboard, not a place you sit.

2. **Resume by replay is fragile for anything long-lived.** A paused run
   resumes by replaying adapter calls from `run.jsonl` in order. If the
   workflow's code changes between pause and resume, replay desyncs. An
   autonomous process will always outlive its code. Durable state has to be
   explicit, not reconstructed from a transcript.

3. **Process-per-run is an accidental operating system.** Detached child
   processes, process groups, pid files, `argv` sniffing, zombie detection,
   implemented twice (TypeScript and Rust). This is the part of an OS you do
   not want to own, and v2 will need a real scheduler anyway.

4. **The "no third concept" purity is what made events impossible.** Because
   the view is an adapter, ask and answer are a file-inbox protocol. Because
   watches are adapter functions returning `next()`, the engine cannot know a
   run is waiting on a PR and cannot wake it; the workflow must hold a thread
   open. The model is elegant on paper. The cost is that reactivity, scheduling,
   and inbox routing all have to be built inside each workflow.

5. **Cost is tracked but never bounded.** Usage notes and a price table exist.
   Nothing stops, slows, or reroutes a process that is spending. An autonomous
   system without budgets is a bill.

6. **Every agent is you.** Comments post as you, commits are yours, the
   keychain is yours. For a business with several roles that breaks audit and
   trust, and it makes it impossible to give a role narrower permissions than
   you have.

7. **The human is in-band.** You answer inside a run's transcript. Two runs
   asking is two notifications and two context switches. Your "two tasks feels
   overwhelming" observation is this exact effect: there is no single queue, no
   ranking, no batching.

8. **Evaluation is aimed at the wrong thing.** `exam.ts`, `score.ts`, and
   `jev-exam.ts` are the strongest asset in the repo, and they grade skills. The
   decisions that cost you attention (was this escalation necessary? was this
   autonomous decision later reversed?) are not measured at all.

9. **Adapters can only be polled, never subscribed to.** There is no way for an
   adapter to say "something happened". Hence 30-second polling loops.

10. **Preferences are literals in process code.** `rounds = 3`,
    `REVIEWER = "cursor"`, `STYLE_DEPTH = 20`, `EYEBALL_LINES = 100`.
    Configuration, policy, and process are entangled, so changing a preference
    means editing a workflow.

## What v1 got right, and what v2 should keep

- Adapters as functions over plain data, and the split between answers (data)
  and refusals (faults). This is the best idea in the repo.
- Typed results from agent turns, validated with a schema and retried once.
- Skills as the home of craft, in the standard Agent Skills format.
- The journal: an append-only record of every call and outcome.
- Gates: deterministic checks a script runs, never an agent.
- A cheap scout before an expensive model (`discover.ts`).
- The reconciler stance: re-read the world before acting on it.
- Jev as a first-class citizen, and the specific places it is used.
- The exam and score harness, and the discipline of grading changes.
- The taste in the README: you pick the workflow, it is clear when a human is
  needed, deterministic things are deterministic calls.

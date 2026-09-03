// Replays the frozen cases an answer key holds through one configuration and grades the answers
// against it, so a change to a skill, a workflow, a model, or an adapter comes back as a pass rate
// and a cost per passed case. Which CLI runs the turns is the `agent` line in ~/.penguin/config, so
// comparing adapters means changing that line and running the exam again.
// usage: bun examples/run.ts examples/workflows/exam.ts '{"key":"<dir>","skill":"commit"}'
import fs from "node:fs";
import path from "node:path";
import { attempt, call, messageOf, workflow, type Ctx, type Workflow } from "penguin";
import { z } from "zod";
import {
  attemptRun,
  costOf,
  dollars,
  entriesOf,
  failed,
  gradeCommit,
  gradeFindings,
  gradeImplement,
  gradePlan,
  identify,
  JUDGED_SKILLS,
  mark,
  pickCases,
  statusPaths,
  SUBJECT_LIMIT,
  table,
  totalsOf,
  type Attempt,
  type Entry,
  type Grade,
  type Picked,
} from "../helpers/exam.ts";
import type { Case, Verdict } from "../helpers/score.ts";
import { narrated } from "../helpers/turns.ts";
import { openWorktree } from "../helpers/worktree.ts";
import { runsDir } from "../../src/paths.ts";
import { Out as PlanOut } from "./plan.ts";
import { checklist, Review } from "./review.ts";
import { Out as TriageOut } from "./triage.ts";

const WINDOW = "200000";

/** How much of an attempt's detail the table carries. The result file holds all of it. */
const DETAIL = 60;

const Params = z.object({
  key: z.string().describe("the folder examples/score.ts --key wrote"),
  skill: z.string().describe("which <skill>.json of that folder is replayed"),
  model: z
    .string()
    .default("big")
    .describe("the tier or model name the turn under test runs on: small, normal, big, or an exact name"),
  judge: z
    .string()
    .default("big")
    .describe("the tier or model name the grader runs on, never the one under test"),
  limit: z.number().int().min(1).default(20).describe("how many cases to replay, newest first"),
  trials: z.number().int().min(1).default(1).describe("how many times each case runs"),
  cases: z
    .array(z.string())
    .default([])
    .describe("the run ids to replay, empty to take the newest cases"),
  only: z.string().default("").meta({ internal: true }),
  trial: z.number().int().default(0).meta({ internal: true }),
});

type Given = z.infer<typeof Params>;

const Graded = z.object({
  pass: z.boolean(),
  rules: z.array(z.object({ name: z.string(), ok: z.boolean().nullable() })),
  detail: z.string(),
  candidate: z.string(),
});

type Graded = z.infer<typeof Graded>;

/** Room for a claim and the file and line it rests on, as the review skills ask for it. */
const LINE = 300;

function line(about: string): z.ZodString {
  return z.string().max(LINE).describe(about);
}

const Dossier = z.object({
  files: z
    .array(
      z.object({
        path: line("the changed file, spelled as the diff spells it"),
        tier: z
          .enum(["ignore", "skim", "deep"])
          .describe(
            "ignore when a command checks it better, skim when a mistake there is cheap, deep when the review turns on it",
          ),
        change: line("what the diff does to this file"),
        read: z
          .array(line("one thing read about this file and what it says, with file:line"))
          .describe(
            "the callers, the called, the contracts, and the config that decide whether the change is right",
          ),
      }),
    )
    .describe("every changed file, in the order the diff names them"),
  flows: z
    .array(
      z.object({
        name: line("what the flow does"),
        entry: line("where execution enters it, with file:line"),
        steps: z.array(line("one step of the flow, with file:line")),
        exits: z.array(line("one way it can end, success, error, or early return, with file:line")),
        effects: z.array(line("one thing it writes, with file:line")),
      }),
    )
    .describe("the end to end paths the change sits in"),
  state: z
    .array(
      z.object({
        name: line("the state, with the file:line that holds it"),
        writers: z.array(line("one writer, with file:line")),
        readers: z.array(line("one reader, with file:line")),
      }),
    )
    .describe("every piece of state the change introduces or touches"),
  facts: z
    .array(line("one fact, with file:line"))
    .describe("what the diff does not show and a reader of the diff alone would have to guess"),
});

type Dossier = z.infer<typeof Dossier>;

const Reviewed = z.object({
  blockers: z.array(z.string()).describe("the issues that must change before an approve"),
  nonBlockers: z.array(z.string()).describe("the improvements the author may take or leave"),
  questions: z
    .array(line("one question about the code, answerable by reading it"))
    .describe("what the tree must answer before these findings are final, empty when none"),
});

type Reviewed = z.infer<typeof Reviewed>;

const Assessment = z.object({
  issues: z
    .array(
      z.object({
        title: z.string().describe("the issue in one short line, in plain words"),
        where: z.string().describe("the file and lines it lands on, empty when it names no code"),
        holds: z.boolean().describe("true when the code confirms the issue"),
        why: z.string().describe("one or two plain sentences on what the code actually does"),
        action: z
          .enum(["change", "reply"])
          .describe("change the code, or reply to the thread and leave the code alone"),
        plan: z
          .string()
          .describe("exactly what changes, file by file, or exactly what the reply says"),
      }),
    )
    .describe("one entry per issue, empty when nothing is left open"),
});

type Assessment = z.infer<typeof Assessment>;

const PlanJudged = z.object({
  equivalent: z.boolean().describe("true when the candidate decides the same work"),
  missing: z.array(z.string()).describe("what the approved answer decides and the candidate leaves out"),
  extra: z.array(z.string()).describe("what the candidate decides and the approved answer does not"),
});

const FindingsJudged = z.object({
  matched: z.array(z.string()).describe("the recorded findings the candidate names too"),
  missed: z.array(z.string()).describe("the recorded findings the candidate does not name"),
  invented: z.array(z.string()).describe("the candidate findings the recorded ones do not name"),
});

function listed(items: string[]): string {
  return items.length === 0 ? "none" : items.map((item) => `- ${item}`).join("\n");
}

/** The findings as the review posts them, which is the shape the key recorded. */
function report(found: Reviewed): string {
  return `### Blockers\n\n${listed(found.blockers)}\n\n### Non-blockers\n\n${listed(found.nonBlockers)}`;
}

/** The proposal as open-pr shows it, which is the shape the key recorded. */
function proposal(assessed: Assessment): string {
  return assessed.issues
    .map((issue, index) => {
      const place = issue.where === "" ? "" : `\n\n${issue.where}`;
      const verdict = issue.holds ? "This holds." : "This does not hold.";
      const doing = issue.action === "change" ? "Change" : "Reply";
      return `### ${index + 1}. ${issue.title}${place}\n\n${verdict} ${issue.why}\n\n**${doing}:** ${issue.plan}`;
    })
    .join("\n\n");
}

/** What a turn put to the person instead of the answer the key holds. */
function askedInstead(out: z.infer<typeof PlanOut> | z.infer<typeof TriageOut>): string {
  if ("decide" in out && out.decide !== undefined) return out.decide.question;
  if ("resplit" in out && out.resplit !== undefined) return out.resplit.reason;
  return (out.blocked?.questions ?? []).join("; ");
}

/** The split as triage shows it, which is the shape the key recorded. */
function split(tasks: string[]): string {
  const numbered = tasks.map((task, index) => `${index + 1}. ${task}`).join("\n");
  return `The ticket splits into ${tasks.length} tasks:\n\n${numbered}`;
}

function dossierOf(found: Dossier): string {
  return `# Dossier\n\nAnother session read the working tree and reports this. It is all you get of the code.\n\n\`\`\`json\n${JSON.stringify(found, null, 2)}\n\`\`\``;
}

function graded(grade: Grade, candidate: string): Graded {
  return { pass: grade.pass, rules: grade.rules, detail: grade.detail, candidate };
}

function casesOf(params: Given): Picked[] {
  const file = path.join(params.key, `${params.skill}.json`);
  if (!fs.existsSync(file)) return [];
  return identify(JSON.parse(fs.readFileSync(file, "utf8")) as Case[]);
}

function runEntries(id: string): Entry[] {
  const file = path.join(runsDir(), id, "run.jsonl");
  return fs.existsSync(file) ? entriesOf(fs.readFileSync(file, "utf8")) : [];
}

/** Every run started since marker, by the head entry that names what it ran. */
function runsSince(marker: string): { id: string; head: Record<string, unknown> }[] {
  const dir = runsDir();
  if (!fs.existsSync(dir)) return [];
  const found: { id: string; head: Record<string, unknown> }[] = [];
  for (const id of fs.readdirSync(dir)) {
    if (id < marker) continue;
    const head = runEntries(id).find((entry) => "workflow" in entry && "params" in entry);
    if (head !== undefined) found.push({ id, head });
  }
  return found;
}

function stamp(): string {
  return new Date().toISOString().replaceAll(":", "-");
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= DETAIL ? flat : `${flat.slice(0, DETAIL - 1)}…`;
}

/** What the person did with the findings the key recorded, said the way the judge reads it. */
function said(verdict: Verdict): string {
  if (verdict === "accepted") return "took these findings as they stood";
  if (verdict === "edited") return "kept these findings and asked for a change";
  return "dropped these findings";
}

/**
 * A scratch worktree on the commit the case started from. The case's own checkout is never
 * touched, and a branch an earlier attempt left behind is put back on that commit rather than
 * carrying its work into this one.
 */
async function scratch(
  ctx: Ctx<Given>,
  picked: Picked,
  at: string | undefined,
): Promise<{ dir: string; sha: string }> {
  const sha = at === undefined || at === "" ? (await ctx.vcs.head()).sha : at;
  const dir = await openWorktree(ctx, `exam-${picked.held.skill}-${picked.held.run}`, { from: sha });
  if (dir !== "") await ctx.vcs.resetHard(sha, { cwd: dir });
  return { dir, sha };
}

async function dropped(ctx: Ctx<Given>, dir: string): Promise<void> {
  if (dir === "") return;
  try {
    // The implement turn leaves the tree dirty, and a teardown never holds the exam at a gate.
    await attempt(() => ctx.vcs.worktree.remove(dir, { force: true }));
  } catch (error) {
    await ctx.view.show(`the worktree stayed: ${messageOf(error)}`);
  }
}

async function judgePlan(ctx: Ctx<Given>, held: Case, candidate: string): Promise<Grade> {
  const session = await ctx.agent.open({ model: ctx.params.judge, tools: [], settings: [] });
  const prompt = `# The approved answer\n\n${held.artifact}\n\n# The candidate\n\n${candidate}`;
  const judged = await narrated(ctx.view, () =>
    ctx.agent.turn(session, { skill: "exam-judge-plan", prompt }, { result: PlanJudged }),
  );
  return gradePlan(judged);
}

async function judgeFindings(ctx: Ctx<Given>, held: Case, candidate: string): Promise<Grade> {
  const session = await ctx.agent.open({ model: ctx.params.judge, tools: [], settings: [] });
  const prompt = `# What the person did\n\nThe person ${said(held.verdict)}.\n\n# The recorded findings\n\n${held.artifact}\n\n# The candidate findings\n\n${candidate}`;
  const judged = await narrated(ctx.view, () =>
    ctx.agent.turn(session, { skill: "exam-judge-findings", prompt }, { result: FindingsJudged }),
  );
  return gradeFindings(judged, held.verdict);
}

/** The commit turn, run as commit.ts opens it: the tree is in the prompt, so nothing is fetched. */
async function tryCommit(ctx: Ctx<Given>, held: Case): Promise<Graded> {
  const paths = statusPaths(held.prompt);
  if (paths.length === 0) return graded(failed("the prompt names no changed files"), "");
  const Commit = z.object({
    files: z
      .array(z.enum(paths as [string, ...string[]]))
      .describe("the paths to commit, empty when nothing belongs in one"),
    subject: z.string().max(SUBJECT_LIMIT).describe("the commit title, under 50 characters"),
    body: z.string().describe("why the change is right, empty when the diff already shows it"),
  });
  const session = await ctx.agent.open({
    model: ctx.params.model,
    tools: [],
    settings: [],
    effort: "low",
  });
  const written = await narrated(ctx.view, () =>
    ctx.agent.turn(session, { skill: "commit", prompt: held.prompt }, { result: Commit }),
  );
  const body = written.body.trim();
  const message = body === "" ? written.subject : `${written.subject}\n\n${body}`;
  return graded(gradeCommit(held.prompt, written, held.artifact), message);
}

async function tryPlan(ctx: Ctx<Given>, picked: Picked): Promise<Graded> {
  const held = picked.held;
  const { dir } = await scratch(ctx, picked, held.head);
  if (dir === "") return graded(failed("no scratch worktree to run in"), "");
  try {
    const session = await ctx.agent.open({ model: ctx.params.model, cwd: dir, autocompact: WINDOW });
    const shape = held.skill === "triage" ? TriageOut : PlanOut;
    const turned = (prompt: string) =>
      narrated(ctx.view, () =>
        ctx.agent.turn(session, { skill: held.skill, prompt }, { result: shape }),
      );
    // The person's answers and revisions follow the ticket, so the replay sends them in turn.
    let out = await turned(held.prompt);
    for (const prompt of held.prompts.slice(1)) out = await turned(prompt);
    if (out.result === undefined) {
      return graded(failed(`the turn asked instead of answering: ${askedInstead(out)}`), "");
    }
    const answer = out.result;
    if ("tasks" in answer && !answer.actionable) {
      return graded(failed(`not actionable: ${answer.reason}`), answer.reason);
    }
    const candidate = "tasks" in answer ? split(answer.tasks) : answer.plan;
    return graded(await judgePlan(ctx, held, candidate), candidate);
  } finally {
    await dropped(ctx, dir);
  }
}

async function tryImplement(ctx: Ctx<Given>, picked: Picked): Promise<Graded> {
  const held = picked.held;
  const { dir, sha } = await scratch(ctx, picked, held.head);
  if (dir === "") return graded(failed("no scratch worktree to run in"), "");
  try {
    const worker = await ctx.agent.open({ model: ctx.params.model, cwd: dir, autocompact: WINDOW });
    await narrated(ctx.view, () =>
      ctx.agent.turn(worker, { skill: "implement", prompt: held.prompt }),
    );
    const ran = await ctx.gates.run({ cwd: dir, since: sha });
    await ctx.view.show(ran.green ? "gates: green" : "gates: red");
    const reviewer = await ctx.agent.open({ model: ctx.params.judge, cwd: dir, autocompact: WINDOW });
    const reviewed = await narrated(ctx.view, () =>
      ctx.agent.turn(
        reviewer,
        {
          skill: "review",
          prompt: checklist({ acceptance: held.prompt, gates: ran.report, base: sha }),
        },
        { result: Review },
      ),
    );
    await ctx.view.show(`verdict: ${reviewed.verdict}`);
    const candidate = `verdict: ${reviewed.verdict}\n\n${reviewed.blocking}\n\n${reviewed.notes}`;
    return graded(gradeImplement(ran.green, reviewed.verdict, reviewed.blocking), candidate);
  } finally {
    await dropped(ctx, dir);
  }
}

async function tryReview(ctx: Ctx<Given>, picked: Picked): Promise<Graded> {
  const held = picked.held;
  const { dir } = await scratch(ctx, picked, held.prHead ?? held.head);
  if (dir === "") return graded(failed("no scratch worktree to run in"), "");
  try {
    // Both halves of the review run on the model under test: the judge half is the skill's own
    // judgment, and grading it is the exam's judge, which is a different session and model.
    await ctx.view.show(`review-gather and review-judge both run on ${ctx.params.model}`);
    const reader = await ctx.agent.open({ model: ctx.params.model, cwd: dir, autocompact: WINDOW });
    const found = await narrated(ctx.view, () =>
      ctx.agent.turn(reader, { skill: "review-gather", prompt: held.prompt }, { result: Dossier }),
    );
    const judge = await ctx.agent.open({ model: ctx.params.model, tools: [], settings: [] });
    const judged = await narrated(ctx.view, () =>
      ctx.agent.turn(
        judge,
        { skill: "review-judge", prompt: `${held.prompt}\n\n${dossierOf(found)}` },
        { result: Reviewed },
      ),
    );
    const candidate = report(judged);
    return graded(await judgeFindings(ctx, held, candidate), candidate);
  } finally {
    await dropped(ctx, dir);
  }
}

async function tryAssess(ctx: Ctx<Given>, picked: Picked): Promise<Graded> {
  const held = picked.held;
  const { dir } = await scratch(ctx, picked, held.head);
  if (dir === "") return graded(failed("no scratch worktree to run in"), "");
  try {
    const session = await ctx.agent.open({ model: ctx.params.model, cwd: dir, autocompact: WINDOW });
    const assessed = await narrated(ctx.view, () =>
      ctx.agent.turn(
        session,
        { skill: "assess-feedback", prompt: held.prompt },
        { result: Assessment },
      ),
    );
    const candidate = proposal(assessed);
    return graded(await judgeFindings(ctx, held, candidate), candidate);
  } finally {
    await dropped(ctx, dir);
  }
}

/** One case, one trial, in a run of its own, so what the attempt spent is its run file's total. */
async function attempted(ctx: Ctx<Given>): Promise<Graded> {
  const found = casesOf(ctx.params).find((one) => one.id === ctx.params.only);
  if (found === undefined) return graded(failed(`${ctx.params.only} names no case`), "");
  try {
    if (ctx.params.skill === "commit") return await tryCommit(ctx, found.held);
    if (ctx.params.skill === "plan" || ctx.params.skill === "triage") return await tryPlan(ctx, found);
    if (ctx.params.skill === "implement") return await tryImplement(ctx, found);
    if (ctx.params.skill === "review-pr") return await tryReview(ctx, found);
    if (ctx.params.skill === "assess-feedback") return await tryAssess(ctx, found);
    return graded(failed(`no grader for ${ctx.params.skill}`), "");
  } catch (error) {
    // One case that will not run is a failed case, never the end of the exam.
    return graded(failed(messageOf(error)), "");
  }
}

const Gate = z.enum(["go", "stop"]);

async function examined(ctx: Ctx<Given>): Promise<unknown> {
  const { params, view } = ctx;
  const nothing = { attempts: 0, passed: 0, usd: 0, file: "" };
  const all = casesOf(params);
  if (all.length === 0) {
    await view.show(`${path.join(params.key, `${params.skill}.json`)} holds no cases`);
    return nothing;
  }
  if (JUDGED_SKILLS.includes(params.skill) && params.judge === params.model) {
    await view.show(
      `${params.skill} is graded by a judge, and the judge is ${params.judge}, which is the model under test. Name another judge.`,
    );
    return nothing;
  }
  const picked = pickCases(all, { limit: params.limit, only: params.cases });
  if (picked.length === 0) {
    await view.show("none of the named cases are in the key");
    return nothing;
  }

  // What the originals cost is the only estimate there is, and it is shown before anything spends.
  let original = 0;
  let unpriced = 0;
  const before: string[][] = [];
  for (const one of picked) {
    const cost = costOf(runEntries(one.held.run));
    if (cost.priced) original += cost.usd;
    else unpriced += 1;
    before.push([one.id, one.held.verdict, dollars(cost.usd, cost.priced)]);
  }
  const runs = picked.length * params.trials;
  await view.show(table(["case", "verdict", "original run"], before));
  await view.show(
    `${runs} runs of ${params.skill} on ${params.model}: ${picked.length} cases, ${params.trials} each`,
  );
  await view.show(
    `the runs these cases came from cost $${original.toFixed(2)} in total, so ${runs} runs land near $${((original / picked.length) * runs).toFixed(2)}. A run that judged several turns cost more than the one case.`,
  );
  if (unpriced > 0) await view.show(`${unpriced} of ${picked.length} cases had no priced usage`);
  if (JUDGED_SKILLS.includes(params.skill)) await view.show(`the grader runs on ${params.judge}`);
  if (await view.ask("Run the exam? go to spend it, stop to leave it.", Gate) === "stop") {
    return nothing;
  }

  const done: Attempt[] = [];
  for (const [index, one] of picked.entries()) {
    for (let trial = 1; trial <= params.trials; trial++) {
      await view.show(`case ${index + 1} of ${picked.length}, trial ${trial} of ${params.trials}`);
      const marker = stamp();
      const answer = Graded.parse(
        await call(
          ctx,
          exam,
          { ...params, only: one.id, trial },
          // The commit turn reads the tree from its prompt. Every other skill needs a checkout.
          params.skill === "commit" ? undefined : { cwd: one.held.root },
        ),
      );
      const ran = attemptRun(runsSince(marker), marker, one.id, trial);
      const cost = ran === undefined ? { usd: 0, judge: 0, priced: false } : costOf(runEntries(ran));
      done.push({ id: one.id, trial, ...answer, ...cost });
    }
  }

  const names = done[0]?.rules.map((rule) => rule.name) ?? [];
  const rows = done.map((one) => [
    one.id,
    `${one.trial}`,
    ...names.map((name) => mark(one.rules.find((rule) => rule.name === name)?.ok ?? null)),
    one.pass ? "pass" : "fail",
    dollars(one.usd, one.priced),
    clip(one.detail),
  ]);
  const total = totalsOf(done);
  await view.show(table(["case", "trial", ...names, "result", "usd", "detail"], rows));
  await view.show(
    `pass rate: ${total.passed}/${total.attempts} (${Math.round(total.rate * 100)}%)`,
  );
  await view.show(
    `cost: ${dollars(total.usd, total.priced)} in all, ${dollars(total.perAttempt, total.priced)} per case, ` +
      `${total.perPass === null ? "-" : dollars(total.perPass, total.priced)} per passed case`,
  );
  await view.show(
    `of that, the model under test spent ${dollars(total.usd - total.judge, total.priced)} and the judge ${dollars(total.judge, total.priced)}`,
  );

  const file = path.join(params.key, `exam-${params.skill}-${stamp()}.json`);
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      {
        at: new Date().toISOString(),
        key: params.key,
        skill: params.skill,
        model: params.model,
        judge: params.judge,
        trials: params.trials,
        totals: total,
        attempts: done,
      },
      null,
      2,
    )}\n`,
  );
  await view.show(`wrote ${file}`);
  return { attempts: total.attempts, passed: total.passed, usd: total.usd, file };
}

/**
 * The exam and one attempt of it are the same workflow, because a child run is spawned by file
 * and a file has one workflow in it. `only` names the case an attempt runs, and is empty for the
 * exam that spawns them.
 */
const exam: Workflow<typeof Params, unknown> = workflow({
  description:
    "replay an answer key's cases through one model and skill set, and grade the answers against what a person accepted",
  params: Params,
  async run(ctx) {
    return ctx.params.only === "" ? examined(ctx) : attempted(ctx);
  },
});

export default exam;

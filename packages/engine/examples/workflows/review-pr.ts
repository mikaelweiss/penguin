import { attempt, messageOf, workflow } from "penguin";
import { z } from "zod";
import { reviewBrief, type Page } from "../helpers/brief.ts";
import {
  briefing as jevBriefing,
  comment as jevComment,
  connections as jevConnections,
  tiers as jevTiers,
} from "../helpers/jev.ts";
import { narrate } from "../helpers/turns.ts";
import { openWorktree } from "../helpers/worktree.ts";

/** What every review worktree is named under, and what the sweep reads a PR number back out of. */
const PREFIX = "review-pr-";

/** How many times one judgment may send the gatherer back for code it cannot read itself. */
const QUESTIONS = 2;

/**
 * How sure the evidence check must be before its answer counts. Below it the claim stands as
 * the judge wrote it, because an unsure check is no evidence either way.
 */
const SETTLED = 0.7;

/** Room for a claim and the file and line it rests on, and no room for a paragraph. */
const LINE = 300;

function line(about: string): z.ZodString {
  return z.string().max(LINE).describe(about);
}

/** One finding: what is wrong, and the code it rests on, so the claim can be checked. */
const Claimed = z.object({
  claim: line("what is wrong and why it matters, in one line"),
  where: line("the file and line the claim rests on, as path:line, or the path when no one line carries it"),
});

const Findings = z.object({
  blockers: z
    .array(Claimed)
    .describe("the issues that must change before an approve"),
  nonBlockers: z
    .array(Claimed)
    .describe("the improvements the author may take or leave"),
});

/** What the reader hands the judge: everything the tree says that the diff does not. */
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

/** What the reader answers when the judge asks for code the dossier does not hold. */
const Answers = z.object({
  answers: z.array(
    z.object({
      question: line("the question, as it was asked"),
      answer: z.string().describe("what the code says, in a few lines, or that it does not say"),
      refs: z.array(line("a file:line the answer rests on")),
    }),
  ),
});

/** The findings, plus what the judge could not settle without reading code. */
const Verdict = Findings.extend({
  questions: z
    .array(line("one question about the code, answerable by reading it"))
    .describe(
      "what the tree must answer before these findings are final, empty when the dossier answers them",
    ),
});

type Claimed = z.infer<typeof Claimed>;
type Findings = z.infer<typeof Findings>;
type Dossier = z.infer<typeof Dossier>;
type Answers = z.infer<typeof Answers>;
type Verdict = z.infer<typeof Verdict>;
type Note = { author: string; at: string; body: string };

function listed(items: string[]): string {
  return items.length === 0 ? "none" : items.map((item) => `- ${item}`).join("\n");
}

function claimed(claims: Claimed[]): string {
  return listed(claims.map((one) => `${one.claim} (\`${one.where}\`)`));
}

function report(findings: Findings): string {
  return `### Blockers\n\n${claimed(findings.blockers)}\n\n### Non-blockers\n\n${claimed(findings.nonBlockers)}`;
}

function verdictOf(judged: Verdict): Findings {
  return { blockers: judged.blockers, nonBlockers: judged.nonBlockers };
}

function noted(notes: Note[]): string {
  return notes.map((note) => `## ${note.author} on ${note.at}\n\n${note.body}`).join("\n\n");
}

/** The paths a unified diff touches, in the order it names them. */
function touched(diff: string): string[] {
  const paths: string[] = [];
  for (const line of diff.split("\n")) {
    if (!line.startsWith("+++ ")) continue;
    const named = line.slice(4).trim();
    if (named === "/dev/null") continue;
    paths.push(named.startsWith("b/") ? named.slice(2) : named);
  }
  return paths;
}

/** What the reviewer would otherwise spend its first calls rebuilding: the base, the files, the diff. */
function changed(base: string, diff: string): string {
  const files = touched(diff);
  const listed = files.length === 0 ? "none read" : files.map((file) => `- ${file}`).join("\n");
  return `# Base\n\norigin/${base}\n\n# Changed files\n\n${listed}\n\n# Diff\n\n${diff}`;
}

/** The tree, as the only shape the judge ever sees it in. */
function dossierOf(found: Dossier): string {
  return `# Dossier\n\nAnother session read the working tree and reports this. It is all you get of the code.\n\n\`\`\`json\n${JSON.stringify(found, null, 2)}\n\`\`\``;
}

function asking(questions: string[]): string {
  return `The judge cannot read the tree and needs these answered from it. Read what each one needs, answer it from the code, and cite the file and line. Facts only, no verdicts.\n\n${listed(questions)}`;
}

function answering(found: Answers): string {
  const said = found.answers
    .map((one) => `## ${one.question}\n\n${one.answer}\n\n${listed(one.refs)}`)
    .join("\n\n");
  return `The reader answered your questions from the tree:\n\n${said}\n\nJudge again with these facts and return the full findings.`;
}

export default workflow({
  description:
    "review an open pull request: triage it first, post the findings, approve when nothing blocks, and re-review every push until it merges or closes",
  params: z.object({ pr: z.string().describe("the pull request, as a number or a url") }),

  async run(ctx) {
    const { params, agent, vcs, github, jev, view } = ctx;
    const found = await github.pr.get(params.pr);
    if (found === null) {
      await view.show(`${params.pr} names no pull request`);
      return { rounds: 0, posted: 0 };
    }
    let pr = found;
    if (pr.state !== "OPEN") {
      await view.show(`PR #${pr.number} is ${pr.state}, nothing to review`);
      return { rounds: 0, posted: 0 };
    }

    let description = pr.body;
    let notes: Note[] = await github.pr.comments(params.pr);

    /** The PR as it stands now, not as a gate's answer left it. False means it is no longer reviewable. */
    const reread = async (): Promise<boolean> => {
      const again = await github.pr.get(params.pr);
      if (again === null) {
        await view.show(`PR #${pr.number} no longer reads, nothing to review`);
        return false;
      }
      pr = again;
      description = pr.body;
      notes = await github.pr.comments(params.pr);
      if (pr.state === "OPEN") return true;
      await view.show(`PR #${pr.number} is ${pr.state}, nothing to review`);
      return false;
    };

    const briefing = (): string => {
      const conversation = notes.length === 0 ? "" : `\n\n# Comments\n\n${noted(notes)}`;
      return `# PR #${pr.number}: ${pr.title}\n\n${pr.url}\n\n${description}${conversation}`;
    };

    // The triage reads the diff over the wire, so a PR the user takes costs no worktree.
    let diff = await github.pr.diff(params.pr);
    /** Jev's word on whether a person reads this in a minute. A failure means the full review, which is what the judgment guards. */
    const triaged = await (async (): Promise<{ eyeball: boolean; reason: string }> => {
      try {
        return await jev.triage.pr({ title: pr.title, description, notes, diff });
      } catch (error) {
        await view.show(`The Jev triage did not run, so the full review does: ${messageOf(error)}`);
        return { eyeball: false, reason: "" };
      }
    })();
    if (triaged.eyeball) {
      const choice = await view.ask(
        `PR #${pr.number} is small enough to read yourself: ${triaged.reason}\n\n${pr.url}\n\nreview runs the full review, mine leaves it to you.`,
        z.enum(["review", "mine"]),
      );
      if (choice === "mine") {
        await view.show(`PR #${pr.number} is yours to read`);
        return { rounds: 0, posted: 0 };
      }
      // The gate can sit for hours, so the review reads the PR again rather than the triage's copy.
      if (!(await reread())) return { rounds: 0, posted: 0 };
    }

    const ref = `pull/${pr.number}/head`;
    const name = `${PREFIX}${pr.number}`;

    /**
     * What earlier reviews left behind. A run killed between its review and the merge never
     * reaches its own teardown, so each review clears the trees whose pull requests are done.
     */
    const sweep = async (): Promise<void> => {
      let held: { path: string; name: string }[];
      try {
        held = await vcs.worktree.list();
      } catch {
        return;
      }
      for (const tree of held) {
        if (tree.name === name || !tree.name.startsWith(PREFIX)) continue;
        const number = tree.name.slice(PREFIX.length);
        if (!/^\d+$/.test(number)) continue;
        try {
          const done = await github.pr.get(number);
          if (done !== null && done.state === "OPEN") continue;
          await vcs.worktree.remove(tree.path, { force: true });
          await view.show(`swept the worktree for PR #${number}: it is ${done?.state ?? "gone"}`);
        } catch (error) {
          await view.show(`the worktree for PR #${number} stayed: ${messageOf(error)}`);
        }
      }
    };
    await sweep();

    const changes = github.pr.changes(params.pr);
    let inbound = changes.next();
    let previous: Findings | undefined;
    /** What Jev's pass over this round's code told the reader, empty when the pass did not run. */
    let screening = "";
    /** The tree around the change, read by the import graph so the reader does not go find it. */
    let around = "";
    /** Which of the last round's findings the new code no longer shows. */
    let settled = "";
    let inDraft = pr.isDraft;
    let paused = pr.isInMergeQueue;
    let owed = true;
    let rounds = 0;
    let posted = 0;
    let head = "";
    let dir = "";
    let reader = "";

    type Change = Awaited<ReturnType<typeof changes.next>>;
    /** The changes that are context for a running turn rather than a reason to stop. */
    type News = Extract<Change, { kind: "commits" | "description" | "comments" }>;
    type Phase = "gather" | "judge";
    type Stop = "approved" | "closed" | "draft" | "queued";
    type Ran<T> = { stop: Stop } | { value: T };

    /** The tree a round reads, cut when one is owed. The reader opens on it and dies with it. */
    const hold = async (): Promise<boolean> => {
      if (dir !== "") return true;
      const cut = await openWorktree(ctx, name, { ref });
      if (cut === "") return false;
      dir = cut;
      reader = await agent.open({ model: "small", cwd: dir, autocompact: "200000" });
      return true;
    };

    /**
     * A full checkout costs too much to hold through a wait that runs for days, and a review
     * with nothing owed has no use for one. Teardown runs here too, so it runs on every exit.
     */
    const drop = async (): Promise<void> => {
      if (dir === "") return;
      const held = dir;
      dir = "";
      reader = "";
      head = "";
      // Best-effort teardown: the review's outcome must not wait on a gate about a folder.
      try {
        await attempt(() => vcs.worktree.remove(held, { force: true }));
      } catch (error) {
        await view.show(`the worktree stayed: ${messageOf(error)}`);
      }
    };

    const screened = (): string =>
      [screening, around].filter((one) => one !== "").map((one) => `\n\n${one}`).join("");

    const answered = (): string => (settled === "" ? "" : `\n\n${settled}`);

    const gathering = (): string =>
      previous === undefined
        ? `Gather the dossier for this pull request. The working tree holds its code.\n\n${briefing()}\n\n${changed(pr.baseRefName, diff)}${screened()}`
        : `New code arrived since the last round, and the working tree holds it. The last round found:\n\n${report(previous)}\n\nRead what changed and the code those findings name, then return the dossier for the code the tree holds now.\n\n${briefing()}\n\n${changed(pr.baseRefName, diff)}${screened()}`;

    const judging = (found: Dossier): string =>
      previous === undefined
        ? `Judge this pull request.\n\n${briefing()}\n\n${changed(pr.baseRefName, diff)}\n\n${dossierOf(found)}`
        : `New code arrived since the last review. The last review found:\n\n${report(previous)}\n\nCheck whether each finding still holds, judge what changed, and return the full updated findings.\n\n${briefing()}\n\n${changed(pr.baseRefName, diff)}${answered()}\n\n${dossierOf(found)}`;

    // The worktree only mirrors the PR head, so a force-push is a reset, not a merge.
    const synced = async (): Promise<void> => {
      await vcs.fetch(ref, { cwd: dir });
      await vcs.resetHard("FETCH_HEAD", { cwd: dir });
      head = (await vcs.sha("HEAD", { cwd: dir })).sha;
      // The diff the reviewer reads must be the code the tree now holds.
      diff = await github.pr.diff(params.pr);
    };

    /** The commit the findings judge, against the commit the PR carries now. */
    const since = async (): Promise<"same" | "moved" | "unread"> => {
      if (dir === "" || head === "") return "unread";
      // A freshness read stays best-effort: a fault here must not hold the review at a gate.
      try {
        return await attempt(async () => {
          await vcs.fetch(ref, { cwd: dir });
          const now = await vcs.sha("FETCH_HEAD", { cwd: dir });
          return now.sha === head ? "same" : "moved";
        });
      } catch {
        return "unread";
      }
    };

    /** A gate the user answers late must not post a verdict on code the review never read. */
    const overtaken = async (): Promise<boolean> => {
      const state = await since();
      if (state === "unread") {
        await view.show("Git did not name the PR head, so this stands on the code the review read.");
        return false;
      }
      if (state === "same") return false;
      await view.show(
        `New code landed on PR #${pr.number}, so nothing was posted. The next round reviews it and carries these findings in.`,
      );
      return true;
    };

    /**
     * Jev's typed pass over the diff the tree holds: posted as its own comment, and handed to
     * the reader as the places to look first. A failure costs the pass, not the round.
     */
    const screen = async (): Promise<void> => {
      screening = "";
      around = "";
      let report;
      try {
        report = await jev.review({ dir, diff });
      } catch (error) {
        await view.show(`The Jev pass did not run: ${messageOf(error)}`);
        return;
      }
      if (report === null) {
        await view.show("The diff holds nothing for Jev to screen.");
        return;
      }
      screening = jevBriefing(report);
      around = [jevTiers(report), jevConnections(report)].filter((one) => one !== "").join("\n\n");
      await github.pr.comment(params.pr, { body: jevComment(report, `\`${head.slice(0, 7)}\``) });
      posted += 1;
      await view.show(
        `Posted Jev's pass on PR #${pr.number}: ${report.files} files screened, ${report.findings.length} findings`,
      );
    };

    /** The claims the code at their own cited line does not carry. A failed check clears none of them. */
    const weak = async (claims: Claimed[]): Promise<Set<number>> => {
      if (dir === "" || claims.length === 0) return new Set();
      try {
        const checked = await jev.check({ dir, claims });
        return new Set(
          checked
            .map((one, index) =>
              one.read && one.confidence >= SETTLED && one.verdict !== "supported" ? index : -1,
            )
            .filter((index) => index !== -1),
        );
      } catch (error) {
        await view.show(`The evidence check did not run, so every claim stands: ${messageOf(error)}`);
        return new Set();
      }
    };

    /**
     * A blocker has to be carried by the code it cites. One that is not still reaches the author,
     * as a non-blocker saying so, because a claim the check cannot place is not a claim disproved.
     */
    const vetted = async (findings: Findings): Promise<Findings> => {
      const failed = await weak(findings.blockers);
      if (failed.size === 0) return findings;
      const blockers = findings.blockers.filter((_, index) => !failed.has(index));
      const demoted = findings.blockers
        .filter((_, index) => failed.has(index))
        .map((one) => ({ ...one, claim: `${one.claim} — the code at this line does not show this` }));
      await view.show(
        `${demoted.length} of ${findings.blockers.length} blockers are not carried by the code they cite, so they no longer block.`,
      );
      return { blockers, nonBlockers: [...findings.nonBlockers, ...demoted] };
    };

    /** What the last round found that this round's code no longer shows. The judge still decides. */
    const recheck = async (): Promise<void> => {
      settled = "";
      if (previous === undefined) return;
      const claims = [...previous.blockers, ...previous.nonBlockers];
      const failed = await weak(claims);
      if (failed.size === 0) return;
      const gone = claims.filter((_, index) => failed.has(index));
      settled = `# Already answered\n\nJev re-read the code these earlier findings name, and it no longer shows them:\n\n${claimed(gone)}\n\nConfirm each from the dossier before you drop it. A finding the code still shows stays.`;
    };

    const post = async (findings: Findings, page: Page | null): Promise<void> => {
      await github.pr.comment(params.pr, { body: report(findings) });
      posted += 1;
      if (page !== null && page.png !== null) await view.image(page.png);
    };

    /** What news that lands mid-turn tells the session that was running. */
    const update = async (change: News, phase: Phase): Promise<string> => {
      if (change.kind === "commits") {
        await synced();
        const carry =
          phase === "gather"
            ? "Read what changed and return the dossier for the code the tree holds now."
            : "Your dossier covers the code before this push. Judge the current diff, and ask for whatever the dossier no longer answers.";
        return `New code was pushed to the PR. The working tree now holds it. ${carry}\n\n${changed(pr.baseRefName, diff)}`;
      }
      if (change.kind === "description") {
        description = change.body;
        return `The PR description changed. The new description:\n\n${change.body}\n\nTake it as added context and continue.`;
      }
      notes = notes.concat(change.comments);
      return `New comments arrived on the PR:\n\n${noted(change.comments)}\n\nTake them as added context and continue.`;
    };

    /** One turn run against the changes watch: news re-asks the same session, an outcome ends the round. */
    const raced = async <Shape extends z.ZodObject>(
      phase: Phase,
      session: string,
      skill: string,
      prompt: string,
      result: Shape,
    ): Promise<Ran<z.infer<Shape>>> => {
      let turn = agent.turn(session, { skill, prompt }, { result });
      let shown = narrate(view, turn.output);
      const stopTurn = async (): Promise<void> => {
        await agent.stop(session);
        await turn.value.catch(() => {});
        await shown;
      };
      for (;;) {
        const first = await Promise.race([
          turn.value.then(
            () => "turn" as const,
            () => "turn" as const,
          ),
          inbound.then(() => "change" as const),
        ]);
        if (first === "turn") break;
        const change = await inbound;
        inbound = changes.next();
        if (change.kind === "closed") {
          await stopTurn();
          await view.show(`PR #${pr.number} is ${change.state}, the review stops`);
          return { stop: "closed" };
        }
        if (change.kind === "approved") {
          await stopTurn();
          await view.show(`PR #${pr.number} is approved, this round has nothing left to say`);
          return { stop: "approved" };
        }
        if (change.kind === "draft") {
          await stopTurn();
          await view.show(`PR #${pr.number} went to draft, the review waits`);
          return { stop: "draft" };
        }
        if (change.kind === "queued") {
          await stopTurn();
          await view.show(`PR #${pr.number} is queued to merge, the review waits`);
          return { stop: "queued" };
        }
        if (change.kind === "ready") continue;
        if (change.kind === "dequeued") continue;
        if (change.kind === "reviewed") continue;
        // The base a stacked pull request moves onto holds the same work, so its diff stands.
        if (change.kind === "retargeted") continue;
        // A stale round syncs before the watch reports, so a push the tree holds already is not news.
        if (change.kind === "commits" && (await since()) !== "moved") continue;
        await stopTurn();
        turn = agent.turn(session, { skill, prompt: await update(change, phase) }, { result });
        shown = narrate(view, turn.output);
      }

      // A turn that will not finish pauses the run. The review takes it up again on the resume.
      try {
        return { value: await turn.value };
      } finally {
        await shown;
      }
    };

    /**
     * One judgment. The judge holds no tools, so what it cannot settle from the dossier it
     * asks for, and the reader answers. The trips are bounded: a judge that keeps asking
     * has to decide on what it holds.
     */
    const settle = async (judge: string, prompt: string): Promise<Ran<Verdict>> => {
      let ran = await raced("judge", judge, "review-judge", prompt, Verdict);
      for (let round = 0; round < QUESTIONS; round++) {
        if ("stop" in ran) return ran;
        if (ran.value.questions.length === 0) return ran;
        const answered = await raced(
          "gather",
          reader,
          "review-gather",
          asking(ran.value.questions),
          Answers,
        );
        if ("stop" in answered) return answered;
        ran = await raced("judge", judge, "review-judge", answering(answered.value), Verdict);
      }
      return ran;
    };

    const review = async (): Promise<
      "approved" | "sent" | "closed" | "draft" | "queued" | "stale"
    > => {
      await synced();
      await recheck();
      await screen();
      const gathered = await raced("gather", reader, "review-gather", gathering(), Dossier);
      if ("stop" in gathered) return gathered.stop;

      // The prompt carries the whole case, so the judge runs with nothing
      // to call: no tools to define, no MCP servers to wait on, and a context that stays flat.
      const judge = await agent.open({ tools: [], settings: [] });
      const judged = await settle(judge, judging(gathered.value));
      if ("stop" in judged) return judged.stop;

      let findings = await vetted(verdictOf(judged.value));
      previous = findings;

      /**
       * The reader writes the page, not the judge: the judge holds no tools, so it can
       * neither write the JSON nor run the renderer.
       */
      const briefed = (found: Findings): Promise<Page | null> =>
        reviewBrief(ctx, reader, {
          about: `${briefing()}\n\nThe base is origin/${pr.baseRefName} and the working tree holds the head. The review judged the code you read, and every finding below goes on the page.\n\n${report(found)}`,
          branch: `pr-${pr.number}`,
        });
      let page = await briefed(findings);

      while (findings.blockers.length > 0) {
        const answer = await view.ask(
          `${report(findings)}\n\nPost this without approving?`,
          z.union([z.enum(["send"]), z.string()]),
        );
        if (answer === "send") {
          if (await overtaken()) return "stale";
          await post(findings, page);
          await view.show(`Posted feedback on PR #${pr.number} without approving`);
          return "sent";
        }
        const said = await settle(
          judge,
          `The user says:\n\n${answer}\n\nAnswer it, adjust the findings where the user is right, and return the full updated findings. When the answer turns on code your dossier does not hold, ask for it in questions rather than guess.`,
        );
        if ("stop" in said) return said.stop;
        findings = await vetted(verdictOf(said.value));
        previous = findings;
        page = await briefed(findings);
      }
      if (await overtaken()) return "stale";
      await post(findings, page);
      try {
        await github.pr.approve(params.pr);
        await view.show(`Approved PR #${pr.number}`);
      } catch (error) {
        // Some approvals are refused outright, e.g. your own PR. The review still counts.
        await view.show(`The approve failed: ${messageOf(error)}`);
      }
      return "approved";
    };

    try {
      for (;;) {
        if (owed && !inDraft && !paused) {
          if (!(await hold())) break;
          rounds += 1;
          await view.show(`review round ${rounds}`);
          const outcome = await review();
          if (outcome === "closed") break;
          if (outcome === "draft") {
            inDraft = true;
            continue;
          }
          if (outcome === "queued") {
            paused = true;
            continue;
          }
          // A round the new code overtook owes a review still, so the loop goes straight round again.
          if (outcome === "stale") continue;
          owed = false;
          continue;
        }
        await drop();
        await view.status(`waiting for changes on PR #${pr.number}`, { idle: true });
        const change = await inbound;
        inbound = changes.next();
        if (change.kind === "closed") {
          await view.show(`PR #${pr.number} is ${change.state}`);
          break;
        }
        if (change.kind === "approved") {
          await view.show(`PR #${pr.number} is approved, the review waits for the merge`);
        }
        if (change.kind === "draft") inDraft = true;
        if (change.kind === "ready") inDraft = false;
        if (change.kind === "queued") {
          paused = true;
          await view.show(`PR #${pr.number} is queued to merge, the review waits`);
        }
        if (change.kind === "dequeued") {
          paused = false;
          await view.show(`PR #${pr.number} left the merge queue`);
        }
        if (change.kind === "commits") owed = true;
        if (change.kind === "description") description = change.body;
        if (change.kind === "comments") notes = notes.concat(change.comments);
      }
    } finally {
      await drop();
    }
    return { rounds, posted };
  },
});

import fs from "node:fs";
import path from "node:path";
import { adapter, PenguinError } from "penguin";
import { authGate, storedFields } from "../helpers/auth.ts";
import {
  changedIn,
  DIMENSIONS,
  graphOf,
  parseHunks,
  relatedTo,
  sizeOf,
  testsFor,
  type Cells,
  type ChangedFile,
  type Dimension,
  type Excerpt,
  type Finding,
  type Hunk,
  type Profile,
  type Report,
  type Tree,
} from "../helpers/jev.ts";
import { priced } from "../helpers/prices.ts";
import type { Usage } from "../helpers/turns.ts";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const KEYS = "https://console.typesafe.ai/settings/keys";
const MODEL = "jev-latest";
const TIMEOUT_MS = 30_000;
/** The GNU pass entry that holds the key, and how long an unlock may take before the read is given up. */
const PASS_ENTRY = "typesafe-ai-api-key";
const PASS_MS = 15_000;
/** Two more tries after a rate limit or an overload, each after a longer pause. */
const RETRIES = 2;
/** Jev takes 1200 requests a minute, so a handful in flight keeps a pass to seconds without nearing it. */
const IN_FLIGHT = 6;
/** A cell at or above this probability is a signal the pass follows into its hunks. */
const SIGNAL = 0.7;
/** How many signals one pass inspects, and how many files it profiles. */
const INSPECTED = 8;
const PROFILED = 5;
/** On the 0 to 3 severity rubric: where a finding names an owner, and where it asks for changes. */
const ROUTED = 1.5;
const BLOCKING = 2;
/** An evidence pick below this confidence is a guess, and the signal is dropped. */
const LOCATED = 0.55;
/** A source file past this size is generated or vendored, and reading it buys nothing. */
const FILE_BYTES = 1_000_000;
/** What a person reads in a minute: a few files, tens of changed lines. Past either, no question is asked. */
const EYEBALL_FILES = 5;
const EYEBALL_LINES = 100;
/** The full review wins a disagreement, so a reason for it counts from low odds, and plainness from high. */
const RISK = 0.3;
const PLAIN = 0.7;
/** Feedback directs the author from even odds. */
const ASKS = 0.5;
/** A ticket is clear enough to build from even odds: a planner asks what a vague one leaves open anyway. */
const CLEAR = 0.5;

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

type Noul = { type: "noul"; instructions: Json; criteria?: { true: Json; false: Json } };
type Choice<Option extends string> = { type: "choice"; instructions: Json; criteria: Record<Option, Json> };
type Score = { type: "score"; instructions: Json; criteria: Json[] };
type Question = Noul | Choice<string> | Score;

type Answer<Q extends Question> = Q extends Noul
  ? { noul: number }
  : Q extends Choice<infer Option>
    ? { choice: Option; probabilities: Record<Option, number>; confidence: number }
    : { score: number; confidence: number };
type Answers<Q extends Record<string, Question>> = { [K in keyof Q]: Answer<Q[K]> };

/** A 401 mid-pass: the key in hand is shelved and the request goes again under the next one. */
class Refused extends Error {}

type Reply = {
  model?: string;
  answers?: Record<string, unknown>;
  usage?: { input_tokens?: number; output_tokens?: number };
};

function noul(instructions: Json, criteria?: { true: Json; false: Json }): Noul {
  return criteria === undefined ? { type: "noul", instructions } : { type: "noul", instructions, criteria };
}

function choice<Option extends string>(instructions: Json, criteria: Record<Option, Json>): Choice<Option> {
  return { type: "choice", instructions, criteria };
}

function score(instructions: Json, levels: readonly string[]): Score {
  return { type: "score", instructions, criteria: [...levels] };
}

const CATEGORIES = {
  behavior: "Adds or changes runtime behavior",
  interface: "Changes an exported API, type, protocol, or data shape",
  infrastructure: "Changes execution, scheduling, build, or operational plumbing",
  observability: "Changes events, logging, monitoring, or diagnostics",
  refactor: "Restructures implementation without intending behavior changes",
  routine: "A small routine change that fits none of the other categories",
};

const PRIORITY = [
  "Routine review is sufficient",
  "A focused review of the changed behavior is useful",
  "Careful review is needed before merge",
  "Specialist or immediate review is needed",
];

const SEVERITY = [
  "No meaningful impact or no supported issue",
  "Minor or narrowly limited impact",
  "Significant correctness, reliability, compatibility, or security impact",
  "Critical security, data loss, or widespread outage impact",
];

const OWNERS = {
  security: "Security, authentication, authorization, or data exposure",
  api: "Public APIs, compatibility, schemas, or protocols",
  runtime: "Execution, concurrency, resources, or failure recovery",
  testing: "Coverage strategy, fixtures, or regression testing",
  maintainer: "The owning domain or feature maintainer",
};

const CONCERNS: Record<Dimension, string> = {
  correctness: "The code likely contains incorrect runtime behavior.",
  security: "The code introduces or weakens a security boundary.",
  reliability: "The code can cause a crash, race, leak, deadlock, or poor failure recovery.",
  compatibility: "The code can break a caller, persisted format, protocol, or public behavior.",
  testGap: "Important behavior lacks adequate targeted test evidence.",
};

const MECHANISMS: Record<Dimension, Record<string, string>> = {
  correctness: {
    condition: "A condition handles the wrong cases",
    state: "State is read, updated, or retained incorrectly",
    dataFlow: "Data is transformed or passed incorrectly",
    asyncControl: "Asynchronous ordering or error handling is incorrect",
    other: "Another concrete correctness mechanism",
    noIssue: "The selected evidence does not support a concrete correctness issue",
  },
  security: {
    authorization: "Authorization or trust boundaries are weakened",
    injection: "Untrusted input can reach an unsafe interpreter or sink",
    exposure: "Sensitive data can be disclosed",
    unsafeDefault: "A default configuration creates avoidable exposure",
    other: "Another concrete security mechanism",
    noIssue: "The selected evidence does not support a concrete security issue",
  },
  reliability: {
    cleanup: "A resource or side effect is not cleaned up",
    concurrency: "Concurrency can race, deadlock, or lose work",
    recovery: "Failure or cancellation recovery is incomplete",
    crash: "A realistic path can throw or terminate unexpectedly",
    other: "Another concrete reliability mechanism",
    noIssue: "The selected evidence does not support a concrete reliability issue",
  },
  compatibility: {
    api: "A public API or type contract changes incompatibly",
    behavior: "Existing callers observe changed behavior",
    dataFormat: "A persisted or exchanged format changes incompatibly",
    protocol: "An external command or protocol contract changes",
    other: "Another concrete compatibility mechanism",
    noIssue: "The selected evidence does not support a concrete compatibility issue",
  },
  testGap: {
    branch: "An important branch lacks targeted coverage",
    failure: "A failure or cancellation path lacks coverage",
    boundary: "A boundary or edge case lacks coverage",
    integration: "An interaction between components lacks coverage",
    other: "Another concrete test gap",
    noIssue: "The selected evidence does not support a concrete test gap",
  },
};

/**
 * The five screening questions over one file. `related` carries what the tree says that the
 * patch does not: the declarations the file imports and the lines of the files that import it.
 */
const SCREENING = {
  correctness: noul(
    {
      question: "Does file.patch directly support that this change introduces incorrect runtime behavior?",
      inspect: "file.patch, read against related for what the code it calls returns and what its callers expect",
      focus: "Concrete behavior, state, data flow, or async errors in the added or changed lines",
      ignore: ["Style preferences", "Naming concerns", "Speculation the code does not support"],
    },
    {
      true: {
        what: "The patch holds a realistic path to a wrong runtime result",
        examples: ["A condition now handles the opposite case", "A caller in related passes a value the new signature misreads"],
      },
      false: {
        what: "The patch is correct, non-behavioral, or shows no direct evidence of a bug",
        examples: ["Formatting only", "A refactor that preserves data flow"],
      },
    },
  ),
  security: noul(
    {
      question: "Does file.patch directly support that this change introduces or weakens a security boundary?",
      inspect: "file.patch, with related for where its inputs come from",
      focus: "Authorization, injection, secret exposure, trust boundaries, and unsafe defaults",
    },
    {
      true: {
        what: "The patch creates a concrete path around a security control or into an unsafe sink",
        examples: ["An authorization check is removed", "Untrusted input reaches command execution"],
      },
      false: {
        what: "No security boundary is weakened by the patch",
        not_for: "Code that merely uses security-related names",
      },
    },
  ),
  reliability: noul(
    {
      question: "Does file.patch directly support that this change can crash, race, leak, deadlock, or recover poorly?",
      inspect: "file.patch, with related for what the code it calls can throw or leave open",
      focus: "Realistic resource, concurrency, cancellation, and failure paths",
    },
    {
      true: {
        what: "A changed path can lose work, leak resources, hang, crash, or leave inconsistent state",
        examples: ["Cleanup is skipped after failure", "Concurrent work updates shared state unsafely"],
      },
      false: { what: "The patch preserves safe lifecycle and failure handling" },
    },
  ),
  compatibility: noul(
    {
      question: "Does file.patch directly support that this change can break an existing caller, format, protocol, or public behavior?",
      inspect: "file.patch, with the importer entries in related for who calls what changed and how",
      focus: "Externally observed contracts rather than internal implementation details",
    },
    {
      true: {
        what: "An existing consumer can fail because a contract changed without a safe migration",
        examples: ["A required field is removed", "An importer in related still calls a removed or renamed export"],
      },
      false: { what: "The changed contract remains compatible, or every caller in related was updated with it" },
    },
  ),
  testGap: noul(
    {
      question: "Does file.patch change important behavior without adequate targeted evidence in changedTests?",
      compare: ["file.patch", "changedTests"],
      focus: "New branches, boundaries, failure paths, and component interactions",
    },
    {
      true: {
        what: "Important changed behavior has no targeted changed test",
        examples: ["A new failure branch has no assertion", "A protocol change lacks a compatibility test"],
      },
      false: {
        what: "Changed tests exercise the important behavior, or the patch is non-behavioral",
        examples: ["A focused regression test covers the branch", "Documentation-only change"],
      },
    },
  ),
};

type Signal = { file: ChangedFile; dimension: Dimension; probability: number };

/**
 * The reasons a pull request needs the full review, over the diff and what the author and
 * reviewers said about it. `plain` is the one reason it does not.
 */
const SHAPE = {
  traced: noul(
    {
      question: "Does diff hold logic a reader has to trace to judge it: control flow, state, concurrency, or error paths?",
      inspect: "diff, with pr.description for what the author says it does",
    },
    {
      true: {
        what: "Judging the change means following how values move or what runs when",
        examples: ["A new branch in a condition", "An await moved across a loop", "A catch that changes what propagates"],
      },
      false: {
        what: "The change is right or wrong on its face",
        examples: ["A copy edit", "A version bump", "A rename", "A comment", "A config value", "A test that follows the pattern next to it"],
      },
    },
  ),
  reaches: noul(
    {
      question: "Does the change reach code the diff does not show: a shared function, an exported symbol, a schema, a migration?",
      inspect: "diff, for what the changed lines are used by outside the changed files",
    },
    {
      true: {
        what: "Whether the change is right depends on callers, readers, or data the diff does not include",
        examples: ["An exported signature changes", "A schema or migration changes", "A shared helper's behavior changes"],
      },
      false: { what: "Every effect of the change is visible in the diff itself" },
    },
  ),
  risky: noul(
    {
      question: "Does the change touch security, permissions, money, or data loss?",
      inspect: "diff, with pr.description and pr.comments for what the code is for",
    },
    {
      true: {
        what: "A mistake in the change would expose data, grant access, move money, or destroy records",
        examples: ["An authorization check", "A payment amount", "A delete or a migration that drops data"],
      },
      false: { what: "A mistake in the change costs a fix and nothing else" },
    },
  ),
  plain: noul(
    {
      question: "Does the change do one plain thing?",
      inspect: "diff, with pr.title and pr.description for what one thing it claims to do",
    },
    {
      true: {
        what: "One purpose, and the diff is all of it",
        examples: ["A copy edit", "A version bump", "A rename", "A dependency bump", "A config value", "A test that follows the pattern next to it"],
      },
      false: {
        what: "Several unrelated things, or one thing whose effect the diff alone does not show",
        examples: ["A rename beside a behavior change", "A new feature", "A refactor that moves logic between files"],
      },
    },
  ),
};

type Risk = "traced" | "reaches" | "risky";
const RISKS: Risk[] = ["traced", "reaches", "risky"];
const RISK_REASONS: Record<Risk, string> = {
  traced: "it holds logic a reader has to trace",
  reaches: "it reaches code the diff does not show",
  risky: "it touches security, permissions, money, or data loss",
};

const REMARKS = {
  approval: "An approval, or a verdict that the work can land as it is: merge it, ship it, no blocking defects",
  summary: "A summary, a scorecard, or a description of what the change does",
  praise: "Praise",
  optional: "A remark marked nit, non-blocking, optional, or take it or leave it",
  otherAddressee: "A note addressed to someone other than the author",
  botStatus: "A status line from a bot: a deploy, a check, a preview link",
  other: "Something else that directs the author to nothing",
};
type Remark = keyof typeof REMARKS;
const REMARK_REASONS: Record<Remark, string> = {
  approval: "it approves the work as it is",
  summary: "it describes the change",
  praise: "it is praise",
  optional: "it is marked optional",
  otherAddressee: "it is addressed to someone else",
  botStatus: "it is a bot's status line",
  other: "it directs the author to nothing",
};

/** Whether one piece of feedback directs the author, and what it is when it does not. */
const FEEDBACK = {
  direction: noul(
    {
      question: "Does feedback.text tell the author to change something, or say something must be fixed, added, or removed?",
      focus: "Whether the author has to act, not whether the claim is true",
    },
    {
      true: {
        what: "The text directs the author to a change",
        examples: ["Add coverage before this merges", "This must handle the empty case"],
      },
      false: {
        what: "An observation, a verdict that the work can land, or a remark marked optional",
        examples: ["Coverage is not present, under a verdict of merge it", "Nit: could be shorter"],
      },
    },
  ),
  question: noul(
    "Does feedback.text ask a question the author has to answer?",
    {
      true: { what: "A question put to the author that the thread waits on" },
      false: {
        what: "No question, a rhetorical one, one the text answers itself, or one put to someone else",
      },
    },
  ),
  requestChanges: noul(
    "Does feedback.text request changes as its verdict?",
    {
      true: { what: "The review's verdict is that changes are requested" },
      false: { what: "It approves, only comments, or gives no verdict" },
    },
  ),
  blocking: noul(
    "Does feedback.text mark something as blocking, required, or to do before merge?",
    {
      true: { what: "A marker that the work cannot land until something is done" },
      false: { what: "No marker, or one that says nit, non-blocking, optional, or take it or leave it" },
    },
  ),
  remark: choice(
    {
      question: "Assuming feedback.text directs the author to nothing, what is it?",
      fallback: "Select other when none of the kinds fits",
    },
    REMARKS,
  ),
};

const MISSING = {
  goal: "It names no outcome: nothing says what should be true when the work is done",
  place: "It names no place: which screen, command, service, or path it is about",
  behavior: "It names an outcome but not the behavior: what should happen, for whom, and when",
  reference: "It points at something the text does not identify: the bug, that screen, the thing we discussed",
  conflict: "It asks for things that contradict each other",
  other: "Something else leaves it unclear",
};
type Missing = keyof typeof MISSING;
const MISSING_REASONS: Record<Missing, string> = {
  goal: "it says no outcome",
  place: "it says no place",
  behavior: "it says what to reach but not what should happen",
  reference: "it points at something it does not identify",
  conflict: "it contradicts itself",
  other: "it leaves the goal unclear",
};

/** Whether a ticket is ready to work on, and what it leaves open when it is not. */
const TICKET = {
  clear: noul(
    {
      question: "Is the goal of ticket clear enough that a planner who reads the code could start from it without asking what it means?",
      focus: "Whether the outcome is stated, not whether the code it names exists or how it is built",
    },
    {
      true: {
        what: "A planner knows what should be true when the work is done, and where",
        examples: ["Add a toggle to the sidebar that hides completed items", "The login form times out after 30s; make it retry once"],
      },
      false: {
        what: "A planner would have to ask the requester what is meant before reading code",
        examples: ["Make it better", "Fix the bug we talked about", "Faster"],
      },
    },
  ),
  missing: choice(
    {
      question: "Assuming ticket is not clear enough to build, what does it leave open?",
      fallback: "Select other when none of the kinds fits",
    },
    MISSING,
  ),
};

type Asking = "direction" | "question" | "requestChanges" | "blocking";
const ASKINGS: Asking[] = ["direction", "question", "requestChanges", "blocking"];
const ASKING_REASONS: Record<Asking, string> = {
  direction: "it tells the author to change something",
  question: "it asks the author a question",
  requestChanges: "it requests changes",
  blocking: "it marks something as required before merge",
};

function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The strongest of the named nouls at or over the bar, or undefined when none reaches it. */
function strongest<Key extends string>(
  answers: Record<Key, { noul: number }>,
  keys: Key[],
  bar: number,
): Key | undefined {
  const over = keys.filter((key) => answers[key].noul >= bar);
  over.sort((a, b) => answers[b].noul - answers[a].noul);
  return over[0];
}

async function mapLimit<T, R>(items: T[], limit: number, job: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await job(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function rested(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default adapter({
  role: "jev",
  name: "jev",
  description:
    "TypeSafe Jev, a model that answers typed questions in a fraction of a second: screens a diff for risk, file by file, with the code around each change as context, and triages tickets, pull requests, and their feedback",
  build: (host) => {
    const refused = new Set<string>();
    let refusal: string | undefined;
    const gate = authGate(host, "jev", {
      fields: [{ name: "key", label: "TypeSafe API key", secret: true }],
      help: { label: "Make an API key", url: KEYS },
      onSave: () => refused.clear(),
    });

    /** The first line of the pass entry, or nothing when pass is absent, locked, or holds no entry. */
    async function fromPass(): Promise<string | undefined> {
      try {
        const done = await host.exec(["pass", "show", PASS_ENTRY], { signal: AbortSignal.timeout(PASS_MS) });
        if (done.code !== 0) return undefined;
        const line = done.stdout.split("\n")[0]?.trim() ?? "";
        return line === "" ? undefined : line;
      } catch {
        return undefined;
      }
    }

    /** Environment, then the keychain, then GNU pass, then ~/.penguin/config. Refused keys wait their turn out. */
    async function key(): Promise<string | { reason: string }> {
      const candidates = [
        process.env["TYPESAFE_API_KEY"],
        (await storedFields(host, "jev"))["key"],
        await fromPass(),
        host.config("typesafe-key"),
      ].filter((one): one is string => one !== undefined && one !== "");
      for (const held of candidates) {
        if (!refused.has(held)) return held;
      }
      if (candidates.length > 0) return { reason: refusal ?? "TypeSafe refused the key: enter a new one" };
      return {
        reason: `TypeSafe needs an API key. Enter it in the penguin app, or set TYPESAFE_API_KEY. Make one at ${KEYS}.`,
      };
    }

    /** A refusal shelves the key and tries the next. The pause comes when nothing is left. */
    async function token(): Promise<string> {
      for (;;) {
        const held = await key();
        if (typeof held === "string") return held;
        await gate.pause(held.reason);
      }
    }

    /** One request under whatever key is accepted now. A refusal shelves the key and asks again. */
    async function ask<Q extends Record<string, Question>>(
      spent: Usage,
      state: Json,
      questions: Q,
    ): Promise<Answers<Q>> {
      for (;;) {
        try {
          return await send(await token(), spent, state, questions);
        } catch (error) {
          if (!(error instanceof Refused)) throw error;
        }
      }
    }

    async function send<Q extends Record<string, Question>>(
      bearer: string,
      spent: Usage,
      state: Json,
      questions: Q,
    ): Promise<Answers<Q>> {
      for (let attempt = 0; ; attempt++) {
        const response = await fetch(ENDPOINT, {
          method: "POST",
          headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: MODEL, state, questions }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if ((response.status === 429 || response.status === 529) && attempt < RETRIES) {
          await rested(1000 * 2 ** attempt);
          continue;
        }
        if (response.status === 401) {
          refused.add(bearer);
          refusal = `TypeSafe refused the key. A new one comes from ${KEYS}.`;
          throw new Refused();
        }
        if (!response.ok) {
          const said = (await response.text()).slice(0, 300);
          throw new PenguinError(`TypeSafe answered ${response.status}: ${said}`);
        }
        const reply = (await response.json()) as Reply;
        if (reply.answers === undefined || typeof reply.answers !== "object") {
          throw new PenguinError("TypeSafe answered without answers");
        }
        spent.model = reply.model ?? spent.model;
        spent.input += reply.usage?.input_tokens ?? 0;
        spent.output += reply.usage?.output_tokens ?? 0;
        return reply.answers as Answers<Q>;
      }
    }

    /** The tracked files of the checkout, read from disk on demand and never twice. */
    async function treeOf(dir: string): Promise<Tree> {
      const listed = await host.exec(["git", "ls-files", "-z"], { cwd: dir });
      if (listed.code !== 0) throw new PenguinError(listed.stderr.trim());
      const files = listed.stdout.split("\0").filter((one) => one !== "");
      const held = new Map<string, string | undefined>();
      return {
        files,
        read: (file) => {
          if (held.has(file)) return held.get(file);
          let text: string | undefined;
          try {
            const at = path.join(dir, file);
            text = fs.statSync(at).size > FILE_BYTES ? undefined : fs.readFileSync(at, "utf8");
          } catch {
            text = undefined;
          }
          held.set(file, text);
          return text;
        },
      };
    }

    /** One signal followed into its hunks: the evidence, the mechanism, the severity, the owner. */
    async function locate(spent: Usage, signal: Signal): Promise<Finding | null> {
      const hunks: Hunk[] = parseHunks(signal.file.patch);
      if (hunks.length === 0) return null;
      const concern = { dimension: signal.dimension, definition: CONCERNS[signal.dimension] };
      const picked = await ask(
        spent,
        {
          file: signal.file.path,
          suspectedConcern: { ...concern, screeningProbability: signal.probability },
          candidateHunks: hunks,
        },
        {
          evidence: choice(
            {
              question: "Which candidate hunk provides the strongest direct evidence for suspectedConcern?",
              fallback: "Select noMatch when no hunk provides sufficient evidence",
            },
            {
              ...Object.fromEntries(
                hunks.map((hunk) => [hunk.id, `Candidate beginning at changed-file line ${hunk.startLine}`]),
              ),
              noMatch: "No candidate hunk directly supports the suspected concern",
            },
          ),
        },
      );
      const evidence = picked.evidence;
      if (evidence.choice === "noMatch" || evidence.confidence < LOCATED) return null;
      const hunk = hunks.find((one) => one.id === evidence.choice);
      if (hunk === undefined) return null;

      const classified = await ask(
        spent,
        { file: signal.file.path, suspectedConcern: concern, selectedEvidence: hunk },
        {
          mechanism: choice(
            "Which mechanism best describes the suspected concern supported by selectedEvidence?",
            MECHANISMS[signal.dimension],
          ),
        },
      );
      const mechanism = classified.mechanism.choice;
      if (mechanism === "noIssue") return null;

      const rated = await ask(
        spent,
        { file: signal.file.path, suspectedConcern: concern, selectedEvidence: hunk },
        {
          severity: score(
            "Assuming selectedEvidence exhibits suspectedConcern, rate the likely production impact.",
            SEVERITY,
          ),
        },
      );
      const severity = rated.severity.score;
      let owner: string | null = null;
      if (severity >= ROUTED) {
        const routed = await ask(
          spent,
          {
            file: signal.file.path,
            concern: { dimension: signal.dimension, mechanism, severity },
            selectedEvidence: hunk,
          },
          { owner: choice("Which reviewer is best suited to investigate this concern?", OWNERS) },
        );
        owner = routed.owner.choice;
      }
      return {
        path: signal.file.path,
        line: hunk.startLine,
        dimension: signal.dimension,
        probability: signal.probability,
        mechanism,
        severity,
        owner,
        action: severity >= BLOCKING ? "request changes" : "comment",
      };
    }

    const fresh = (): Usage => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });

    function noted(spent: Usage): void {
      host.note({
        usage: {
          adapter: "jev",
          session: "jev",
          ...priced({ ...spent, model: spent.model ?? MODEL }, host.config),
        },
      });
    }

    return {
      triage: {
        /**
         * Whether a ticket is ready to work on: its goal is clear enough that a planner could
         * start from it. `reason` is what it leaves open when it is not.
         */
        async ticket(options: { ticket: string }): Promise<{ actionable: boolean; reason: string }> {
          const spent = fresh();
          const answers = await ask(spent, { ticket: options.ticket }, TICKET);
          noted(spent);
          if (answers.clear.noul >= CLEAR) return { actionable: true, reason: "the goal is clear enough to build" };
          return { actionable: false, reason: MISSING_REASONS[answers.missing.choice as Missing] };
        },

        /**
         * Whether a person can read the whole pull request and judge it in a minute. Size is
         * counted here and settles it alone; Jev judges the shape of what is small enough.
         * `reason` is the one fact that decided it.
         */
        async pr(options: {
          title: string;
          description: string;
          notes: { author: string; body: string }[];
          diff: string;
        }): Promise<{ eyeball: boolean; reason: string }> {
          const size = sizeOf(options.diff);
          if (size.files > EYEBALL_FILES) return { eyeball: false, reason: `${size.files} files change` };
          if (size.lines > EYEBALL_LINES) return { eyeball: false, reason: `${size.lines} lines change` };
          const spent = fresh();
          const answers = await ask(
            spent,
            {
              pr: { title: options.title, description: options.description, comments: options.notes },
              diff: options.diff,
            },
            SHAPE,
          );
          noted(spent);
          const risk = strongest(answers, RISKS, RISK);
          if (risk !== undefined) return { eyeball: false, reason: RISK_REASONS[risk] };
          if (answers.plain.noul < PLAIN) {
            return { eyeball: false, reason: "it does more than one plain thing" };
          }
          return {
            eyeball: true,
            reason: `${counted(size.files, "file")} and ${counted(size.lines, "changed line")} doing one plain thing`,
          };
        },

        /**
         * Whether one comment or review directs the author to do anything, read from its text
         * alone. `why` is the one fact that decided it.
         */
        async feedback(options: { author: string; text: string }): Promise<{ asks: boolean; why: string }> {
          const spent = fresh();
          const answers = await ask(spent, { feedback: options }, FEEDBACK);
          noted(spent);
          const asking = strongest(answers, ASKINGS, ASKS);
          if (asking !== undefined) return { asks: true, why: ASKING_REASONS[asking] };
          return { asks: false, why: REMARK_REASONS[answers.remark.choice as Remark] };
        },
      },

      /**
       * The pass over one diff, with the checkout at `dir` holding the code it changes: every
       * file screened on five concerns, the strongest cells followed into their hunks, and the
       * findings scored and routed. Null when the diff holds nothing to screen.
       */
      async review(options: { dir: string; diff: string }): Promise<Report | null> {
        const { files, tests } = changedIn(options.diff);
        if (files.length === 0) return null;
        const tree = await treeOf(options.dir);
        const graph = graphOf(tree);
        const spent = fresh();
        let context = 0;

        const screened = await mapLimit(files, IN_FLIGHT, async (file) => {
          const related: Excerpt[] = relatedTo(graph, tree, file.path);
          context += related.length;
          const changedTests = testsFor(graph, tests, file.path).map((test) => ({
            path: test.path,
            patch: test.patch,
          }));
          const answers = await ask(
            spent,
            { file: { path: file.path, patch: file.patch }, related, changedTests },
            SCREENING,
          );
          const cells = Object.fromEntries(
            DIMENSIONS.map((dimension) => [dimension, answers[dimension].noul]),
          ) as Cells;
          return { file, cells };
        });

        const signals: Signal[] = screened
          .flatMap(({ file, cells }) =>
            DIMENSIONS.map((dimension) => ({ file, dimension, probability: cells[dimension] })),
          )
          .filter((one) => one.probability >= SIGNAL)
          .sort((a, b) => b.probability - a.probability);

        const strongest = (cells: Cells): number => Math.max(...Object.values(cells));
        const profiled = [...screened]
          .sort((a, b) => strongest(b.cells) - strongest(a.cells))
          .slice(0, PROFILED);
        const profiles: Profile[] = await mapLimit(profiled, IN_FLIGHT, async ({ file, cells }) => {
          const answers = await ask(
            spent,
            { file: { path: file.path, patch: file.patch }, screening: cells },
            {
              category: choice(
                { question: "Which category best describes file.patch?", focus: "Primary purpose of the change" },
                CATEGORIES,
              ),
              priority: score(
                "Rate how closely a human should review file.patch, considering the code and screening.",
                PRIORITY,
              ),
            },
          );
          return { path: file.path, category: answers.category.choice, priority: answers.priority.score };
        });

        const inspected = signals.slice(0, INSPECTED);
        const located = await mapLimit(inspected, IN_FLIGHT, (signal) => locate(spent, signal));
        const findings = located
          .filter((one): one is Finding => one !== null)
          .sort((a, b) => b.severity - a.severity);

        noted(spent);

        return {
          files: files.length,
          tests: tests.length,
          context,
          signal: SIGNAL,
          matrix: screened.map(({ file, cells }) => ({ path: file.path, cut: file.cut, cells })),
          profiles,
          findings,
          funnel: {
            cells: files.length * DIMENSIONS.length,
            signals: signals.length,
            inspected: inspected.length,
            located: findings.length,
            routed: findings.filter((one) => one.owner !== null).length,
          },
        };
      },
    };
  },
});

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
    "TypeSafe Jev, a model that answers typed questions in a fraction of a second: screens a diff for risk, file by file, with the code around each change as context",
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

    return {
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
        const spent: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
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

        host.note({
          usage: {
            adapter: "jev",
            session: "jev",
            ...priced({ ...spent, model: spent.model ?? MODEL }, host.config),
          },
        });

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

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { adapter, PenguinError } from "penguin";
import { authGate, storedFields } from "../helpers/auth.ts";
import {
  changedIn,
  codeAt,
  DIMENSIONS,
  graphOf,
  parseHunks,
  relatedTo,
  probeSignals,
  codeFor,
  docsFor,
  sizeOf,
  testSummaries,
  type Cells,
  type ChangedFile,
  type Checked,
  type Claim,
  type Dimension,
  type Excerpt,
  type Finding,
  type Hunk,
  type Profile,
  type Report,
  type Signal,
  type Tier,
  type Tree,
  type Verdict,
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
/**
 * Per concern, the pass follows the strongest cells at or above the floor, up to a quota. A
 * screen reads one patch with excerpts around it, so a real defect can sit well under 0.5
 * while still topping its column; rank within the concern is the signal, not the number.
 */
const FLOOR = 0.2;
/** The quota grows with the change: one slot per this many files, between the two bounds. */
const PER_CONCERN = { least: 3, most: 12, filesEach: 6 };
/** A window at or above this probability holds evidence, and the most of them one signal follows. */
const EVIDENCE = 0.5;
const PER_SIGNAL = 2;
/** How many files the pass profiles. */
const PROFILED = 5;
/** On the 0 to 3 severity rubric, where a finding names the reviewer it goes to. */
const ROUTED = 1.5;
/** A source file past this size is generated or vendored, and reading it buys nothing. */
const FILE_BYTES = 1_000_000;
/** How much of the pull request's own text a screen carries, for the probes that hold the change to what it claims. */
const ABOUT_CHARS = 6_000;
const DOC = /\.(?:mdx?|txt|rst)$|(?:^|\/)docs\/.*\.html$/;
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

/** One window of a file judged by one probe. */
type Window = { probe: string; hunk: Hunk; probability: number };

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

const TIER_CRITERIA: Record<Tier, Json> = {
  ignore: {
    what: "A person reading it learns nothing that a build, a type check, or a test would not catch first",
    examples: [
      "Build and project scaffolding: tsconfig, project.json, a bundler config, a package manifest",
      "Generated output, a lock file, a pure rename, formatting only",
      "A stylesheet or token file with no logic in it",
    ],
  },
  skim: {
    what: "It carries behavior, but a mistake in it is cheap or shows on sight",
    examples: ["Wiring and registration", "Constants and types", "A straightforward mapper or query", "A test fixture"],
  },
  deep: {
    what: "The review turns on it",
    examples: [
      "It decides behavior under a condition",
      "It guards a boundary: authorization, validation, a feature flag",
      "It coordinates state, concurrency, or ordering",
      "It handles failure, cancellation, or cleanup",
    ],
  },
};

/**
 * What the evidence check may answer about one claim a review makes. A claim names a mechanism
 * and what would follow from it. Only the mechanism has to be on the page: the consequence is
 * the reader's inference, and holding the code to it reads every true claim as unsupported.
 */
const CLAIM_VERDICTS: Record<Verdict, Json> = {
  supported: {
    what: "The code holds the mechanism the claim rests on",
    examples: [
      "The claim names an ordering, and the code performs those steps in that order",
      "The claim names a missing check, and the code takes that path without it",
      "The claim names a condition or value, and the code uses that condition or value",
    ],
    note: "What the claim says would follow is an inference. The code does not have to state it, and a consequence the code never mentions does not make the claim unsupported",
  },
  unsupported: {
    what: "The code does not hold the mechanism, whatever is true elsewhere in the codebase",
    examples: ["These lines do something unrelated to the claim", "The mechanism lives in a file this code only calls"],
  },
  contradicted: {
    what: "The code does the opposite of the mechanism the claim describes, so the claim is wrong about these lines",
    examples: ["The claim says a guard is missing, and the guard is right there", "The claim says two steps run in an order, and the code runs them the other way"],
  },
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

type Probe = { dimension: Dimension; docs?: boolean; ask: Noul };

/**
 * What one screen call asks over one file. Each probe is a shape a review has accepted before:
 * a cache one view refreshes and another does not, an error shown as nothing, a control that
 * does nothing, a route past the flag, a doc the code contradicts. `related` carries what the
 * tree says that the patch does not, and `pr` what the author says the change is.
 */
export const PROBES = {
  correctness: {
    dimension: "correctness",
    ask: noul(
      {
        question: "Does file.patch directly support that this change introduces incorrect runtime behavior?",
        inspect: [
          "file.patch, read against related for what the code it calls returns and what its callers expect",
          "Each changed function's name and doc comment against the condition its body enforces",
        ],
        focus: "Concrete behavior, state, data flow, or async errors in the added or changed lines",
        ignore: ["Style preferences", "Naming concerns", "Speculation the code does not support"],
      },
      {
        true: {
          what: "The patch holds a realistic path to a wrong runtime result",
          examples: [
            "A condition now handles the opposite case",
            "A caller in related passes a value the new signature misreads",
            "A filter or query admits cases that its own name, doc comment, or caller says it must exclude",
            "A loop or traversal reads only the first element of a collection it should walk",
          ],
        },
        false: {
          what: "The patch is correct, non-behavioral, or shows no direct evidence of a bug",
          examples: ["Formatting only", "A refactor that preserves data flow"],
        },
      },
    ),
  },
  staleCache: {
    dimension: "correctness",
    ask: noul(
      {
        question:
          "Does file.patch add or change a write, a mutation, delete, update, or store write, whose success path refreshes fewer places than show the data it changed?",
        inspect: [
          "file.patch, for what the write changes and what its success path invalidates, patches, refetches, or resets",
          "related, for the query keys, stores, and importers that show the same data under another key, view, or mode",
        ],
        focus: "Whether every list, cache, or view that displays the changed rows is refreshed or patched, not whether the write itself is right",
      },
      {
        true: {
          what: "Some place that shows the changed data keeps showing the old data after the write succeeds",
          examples: [
            "The success path invalidates the folder list, and related shows the same rows listed under an area, search, or detail key too",
            "A cache patch updates one query's rows while a second query in related holds copies of the same rows",
            "A delete awaits the refetch of the deleted row's own query, so the refetch rejects and the delete reports an error",
            "A send succeeds and the list that would show the new row is not invalidated, so the action can be repeated",
          ],
        },
        false: { what: "Every consumer of the changed data is refreshed or patched, or the patch holds no write" },
      },
    ),
  },
  errorAsEmpty: {
    dimension: "correctness",
    ask: noul(
      {
        question: "Does file.patch show a failed request as an empty, default, or loading state instead of an error?",
        inspect: "file.patch, for how a query's data, isError, isLoading, or a catch block feeds what renders or returns",
      },
      {
        true: {
          what: "A failure reaches the user as nothing wrong",
          examples: [
            "`query.data ?? []` renders the empty state while the query errored",
            "isLoading is derived from the data alone and never reads isError, so a 403 or 500 renders as no rows",
            "A catch returns a default the caller cannot tell from a real result",
          ],
        },
        false: { what: "The error state renders or propagates as an error, or the patch makes no request" },
      },
    ),
  },
  deadControl: {
    dimension: "correctness",
    ask: noul(
      {
        question:
          "Does file.patch render a control or accept a handler that does nothing: a handler missing or a no-op, a prop received and never used, a callback passed down and dropped?",
        inspect: [
          "file.patch, for each rendered control and where its handler comes from",
          "related, for what the importers pass in and what the imported component does with it",
        ],
      },
      {
        true: {
          what: "A control the user can reach has no effect, or a value the caller sends goes nowhere",
          examples: [
            "A button renders enabled and the importer in related passes no handler for it",
            "A component accepts a permissions prop and never reads it",
            "A handler is destructured and never attached",
          ],
        },
        false: { what: "Every control's handler reaches an effect, or the patch renders no control" },
      },
    ),
  },
  transition: {
    dimension: "correctness",
    ask: noul(
      {
        question:
          "Does file.patch hold state that is set on one path and not reset on the path back, or a value captured before a list changes and used after?",
        inspect: "file.patch, for every state set, ref write, and effect dependency, and for each what clears or recomputes it",
      },
      {
        true: {
          what: "A state or index goes stale on a path the patch does not handle",
          examples: [
            "A status set to loading on the slow path and never set on the cached path, so it sticks",
            "An index into a list captured before more pages load and read after they do",
            "A selection cleared on one navigation action and kept on the others",
            "Seeding that runs only when a dialog opens, so a second open with new inputs keeps the old values",
            "A latch set once that a later change never clears",
          ],
        },
        false: { what: "Every transition resets what it must, or the patch holds no such state" },
      },
    ),
  },
  parity: {
    dimension: "correctness",
    ask: noul(
      {
        question:
          "Does the twin in related, the file this one was copied or ported from, do something on a path that file.patch skips or does differently?",
        inspect: "The twin entry in related against file.patch, where they correspond",
      },
      {
        true: {
          what: "The copy diverges from the twin on a path that matters",
          examples: [
            "The twin clears the selection on every navigation and the copy on one",
            "The twin invalidates two keys and the copy one",
            "The twin sorts by kind and the copy by name",
            "The twin queues a follow-up job the copy does not",
          ],
        },
        false: { what: "No twin in related, or the copy matches the twin on every path that matters" },
      },
    ),
  },
  constant: {
    dimension: "correctness",
    ask: noul(
      {
        question:
          "Does file.patch use a literal, unit, divisor, mapping, or label that does not match what its name, its comment, its consumer, or a doc in related says it should be?",
        inspect: "Each literal in file.patch against the name and comment beside it and the caller or doc in related",
      },
      {
        true: {
          what: "A value is wrong for what it is named or used as",
          examples: [
            "Elapsed-time units divided by working-time divisors",
            "A false boolean rendered as Required",
            "A route pattern that matches a path it must not",
            "A query key or screen key that differs from the one the twin shares",
          ],
        },
        false: { what: "Every literal matches what is said about it, or the patch holds none" },
      },
    ),
  },
  staleDoc: {
    dimension: "correctness",
    ask: noul(
      {
        question: "Does a doc entry in related describe a label, control, order, color, or behavior that file.patch changes or removes?",
        inspect: "The doc entries in related, which are walkthroughs that mention the labels file.patch touches, against what file.patch now does",
      },
      {
        true: {
          what: "A walkthrough now tells the tester something the code no longer does",
          examples: [
            "The doc names a button style the patch changes",
            "The doc tells the tester to expect an order the patch no longer produces",
            "The doc names a control the patch renames or removes",
          ],
        },
        false: { what: "No doc entry in related, or every line of it still holds" },
      },
    ),
  },
  docMismatch: {
    dimension: "correctness",
    docs: true,
    ask: noul(
      {
        question:
          "Does file.patch, a document, describe a control, label, order, color, step, or outcome that the code in related does not implement or contradicts?",
        inspect: "Each step and claim in file.patch against the code entries in related, which are the source patches of the same change that share its words",
      },
      {
        true: {
          what: "A tester following the doc would mark a step failed against this code",
          examples: [
            "The doc says the video keeps playing and the code pauses it",
            "The doc expects one group listed first and the code sorts alphabetically",
            "The doc names a header control that no code renders",
            "The doc describes a state this build cannot reach",
          ],
        },
        false: { what: "Every claim in the doc matches the code, or related holds no code" },
      },
    ),
  },
  security: {
    dimension: "security",
    ask: noul(
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
        false: { what: "No security boundary is weakened by the patch", not_for: "Code that merely uses security-related names" },
      },
    ),
  },
  flagLeak: {
    dimension: "security",
    ask: noul(
      {
        question:
          "Does file.patch make a route, control, or behavior reachable outside the feature flag, kill switch, role, or ownership check that pr says gates it, or that its neighbours in related use?",
        inspect: [
          "pr, for the flag or switch the author says gates this change",
          "file.patch, for each new route, control, or branch and what gates it",
          "related, for the check the neighbouring routes or controls perform",
        ],
      },
      {
        true: {
          what: "Something new ships outside the gate the change claims or its neighbours use",
          examples: [
            "A new route registered without the flag guard its sibling routes pass",
            "A control added to a shared component that also renders on pages the flag does not cover",
            "A rename or behavior change shipped outside the kill switch the description says covers the change",
          ],
        },
        false: { what: "Every new path sits behind the gate, or pr names no gate and the neighbours use none" },
      },
    ),
  },
  reliability: {
    dimension: "reliability",
    ask: noul(
      {
        question: "Does file.patch directly support that this change can crash, race, leak, deadlock, or recover poorly?",
        inspect: "file.patch, with related for what the code it calls can throw or leave open",
        focus: "Realistic resource, concurrency, cancellation, and failure paths",
      },
      {
        true: {
          what: "A changed path can lose work, leak resources, hang, crash, or leave inconsistent state",
          examples: [
            "Cleanup is skipped after failure",
            "Concurrent work updates shared state unsafely",
            "An irreversible effect runs before the local record that depends on it is saved",
            "Work is reported done before the step that makes it durable runs",
          ],
        },
        false: { what: "The patch preserves safe lifecycle and failure handling" },
      },
    ),
  },
  compatibility: {
    dimension: "compatibility",
    ask: noul(
      {
        question: "Does an importer in related still call what file.patch removed, renamed, or reshaped, in a way that now fails or misbehaves?",
        inspect: "The importer entries in related, for the exact call, against the signature or shape file.patch leaves",
        focus: "A caller the patch did not update, not the fact that a contract changed",
      },
      {
        true: {
          what: "A caller in related is broken by the change and not updated with it",
          examples: ["An importer still passes a removed field", "An importer still calls a renamed export", "A persisted format changes with no migration for what is stored"],
        },
        false: { what: "Every importer in related was updated with the change, or none uses what changed" },
      },
    ),
  },
  testGap: {
    dimension: "testGap",
    ask: noul(
      {
        question: "Does file.patch change important behavior that no test named in changedTests exercises?",
        inspect:
          "changedTests lists every test file the change adds or edits, with the names of its tests. A test counts when its name describes the behavior file.patch adds or changes, even from a different file. targeted marks the test files the tree ties to this file",
        focus: "New branches, boundaries, failure paths, and component interactions",
      },
      {
        true: {
          what: "Important changed behavior has no test in changedTests whose name covers it",
          examples: ["A new failure branch has no test named for it", "A new route has no test that names the permission-denied case"],
        },
        false: {
          what: "A test in changedTests names the important behavior, or the patch is non-behavioral",
          examples: ["Documentation-only change", "A type or interface with no runtime behavior"],
        },
      },
    ),
  },
} satisfies Record<string, Probe>;

export type ProbeName = keyof typeof PROBES;
export const PROBE_NAMES = Object.keys(PROBES) as ProbeName[];
export const PROBE_DIMENSIONS = Object.fromEntries(
  PROBE_NAMES.map((name) => [name, PROBES[name].dimension]),
) as Record<string, Dimension>;

const TIER = choice(
  {
    question: "How closely does a person have to read file.patch for this review to be sound?",
    inspect: "file.patch, and what related says the code around it expects",
    focus: "What a mistake in these lines would cost, not how long the patch is",
  },
  TIER_CRITERIA,
);

/** The probes one file gets: the document probe for a document, the rest for code. */
export function screeningFor(doc: boolean): Record<string, Question> {
  const asked = PROBE_NAMES.filter((name) => (PROBES[name] as Probe).docs === true === doc);
  return { ...Object.fromEntries(asked.map((name) => [name, PROBES[name].ask])), tier: TIER };
}

/**
 * One question per window of a file: does this window alone show the concern? The criteria
 * are the probe's own, so a window is judged on the concrete mechanisms and not on the label.
 */
export function windowQuestions(probe: ProbeName, hunks: Hunk[]): Record<string, Noul> {
  const screened = PROBES[probe].ask.criteria;
  return Object.fromEntries(
    hunks.map((hunk, index) => [
      hunk.id,
      noul(
        {
          question: `Do the lines of \`candidateHunks[${index}]\` directly show suspectedConcern?`,
          inspect: `\`candidateHunks[${index}]\` alone, read against related for what the code it calls does and what its callers expect`,
          ignore: "Evidence that sits in another hunk",
        },
        {
          true: { what: "These lines hold the mechanism of the concern", mechanisms: screened?.true ?? null },
          false: { what: "These lines do not show it, even where another hunk of the file might", mechanisms: screened?.false ?? null },
        },
      ),
    ]),
  );
}
/** The most windows one file is judged on, and the most questions one call carries. */
const HUNKS_EACH = 12;
const QUESTIONS_EACH = 60;
/** The most files one ranking call compares. */
const RANKED_EACH = 20;
/** The windows each candidate shows when ranked. */
const WINDOWS_SHOWN = 2;

/** The concerns the deep files are ranked on, side by side. The strongest answer is a file's rank. */
const RANKINGS: Record<string, string> = {
  worst: "Which candidate window most likely holds a defect a reviewer would block the merge on?",
  staleCache: "Which candidate window most likely writes data and leaves a list, cache, or view that shows it unrefreshed?",
  errorAsEmpty: "Which candidate window most likely shows a failed request as an empty, default, or loading state?",
  transition: "Which candidate window most likely leaves state stale on a transition it does not handle, or uses an index captured before its list changed?",
  deadControl: "Which candidate window most likely renders a control or accepts a handler that does nothing?",
  gate: "Which candidate window most likely ships a route, control, or behavior outside the flag, switch, or permission check that gates its neighbours?",
  claim: "Which candidate window most likely contradicts what pr says the change does, or what a walkthrough in it describes?",
};

/**
 * One question per probe per window: does this window alone show the probe's concern? The
 * window is small enough to answer about, and the file and its connections stay in view.
 */
export function hunkQuestions(probes: ProbeName[], hunks: Hunk[]): Record<string, Noul> {
  const out: Record<string, Noul> = {};
  for (const probe of probes) {
    const ask = PROBES[probe].ask;
    const asked = typeof ask.instructions === "object" && ask.instructions !== null && !Array.isArray(ask.instructions)
      ? (ask.instructions as Record<string, Json>)
      : { question: ask.instructions };
    hunks.forEach((hunk, index) => {
      out[`${probe}__${hunk.id}`] = noul(
        {
          ...asked,
          window: `Answer for the lines of \`hunks[${index}]\` alone, read with the rest of file.patch and related as context. Evidence that sits only in another window does not count.`,
        },
        ask.criteria,
      );
    });
  }
  return out;
}

/** A record's entries in groups, so one call never carries more questions than it should. */
export function chunked<T>(entries: [string, T][], size: number): [string, T][][] {
  const groups: [string, T][][] = [];
  for (let from = 0; from < entries.length; from += size) groups.push(entries.slice(from, from + size));
  return groups;
}

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
      const cacheDir = process.env["PENGUIN_JEV_CACHE"];
      const cacheKey = cacheDir === undefined || cacheDir === "" ? undefined : path.join(cacheDir, `${crypto.createHash("sha256").update(JSON.stringify({ model: MODEL, state, questions })).digest("hex")}.json`);
      if (cacheKey !== undefined && fs.existsSync(cacheKey)) {
        return JSON.parse(fs.readFileSync(cacheKey, "utf8")) as Answers<Q>;
      }
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
        if (cacheKey !== undefined) {
          fs.mkdirSync(path.dirname(cacheKey), { recursive: true });
          fs.writeFileSync(cacheKey, JSON.stringify(reply.answers));
        }
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

    /**
     * One signal followed into its windows: the strongest windows the screen already judged,
     * each classified and rated, the serious ones routed. A file can hold the same concern in
     * two places, so a signal can end as two findings.
     */
    async function locate(
      spent: Usage,
      signal: Signal,
      file: ChangedFile,
      related: Excerpt[],
      windows: Window[],
    ): Promise<Finding[]> {
      const concern = { dimension: signal.dimension, probe: signal.probe, definition: CONCERNS[signal.dimension] };
      const strongest = windows
        .filter((one) => one.probe === signal.probe && one.probability >= EVIDENCE)
        .sort((a, b) => b.probability - a.probability)
        .slice(0, PER_SIGNAL);

      const findings: Finding[] = [];
      for (const { hunk } of strongest) {
        const classified = await ask(
          spent,
          { file: file.path, suspectedConcern: concern, related, selectedEvidence: hunk },
          {
            mechanism: choice(
              "Which mechanism best describes the suspected concern supported by selectedEvidence?",
              MECHANISMS[signal.dimension],
            ),
            severity: score(
              "Assuming selectedEvidence exhibits suspectedConcern, rate the likely production impact.",
              SEVERITY,
            ),
          },
        );
        const mechanism = classified.mechanism.choice;
        if (mechanism === "noIssue") continue;
        // The report prints one decimal, so the action follows the number the reader sees.
        const severity = Math.round(classified.severity.score * 10) / 10;
        let owner: string | null = null;
        if (severity >= ROUTED) {
          const routed = await ask(
            spent,
            {
              file: file.path,
              concern: { dimension: signal.dimension, mechanism, severity },
              selectedEvidence: hunk,
            },
            { owner: choice("Which reviewer is best suited to investigate this concern?", OWNERS) },
          );
          owner = routed.owner.choice;
        }
        findings.push({
          path: file.path,
          line: hunk.startLine,
          dimension: signal.dimension,
          probe: signal.probe,
          probability: signal.probability,
          mechanism,
          severity,
          owner,
        });
      }
      return findings;
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
         * start from it. `reason` is what it leaves open when it is not, and `missing` names the
         * kind, so a caller can tell a vague ticket from one pointing where Jev cannot read.
         */
        async ticket(options: {
          ticket: string;
        }): Promise<{ actionable: boolean; reason: string; missing?: Missing }> {
          const spent = fresh();
          const answers = await ask(spent, { ticket: options.ticket }, TICKET);
          noted(spent);
          if (answers.clear.noul >= CLEAR) return { actionable: true, reason: "the goal is clear enough to build" };
          const missing = answers.missing.choice as Missing;
          return { actionable: false, reason: MISSING_REASONS[missing], missing };
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
       * Each claim read against the code it names, in the checkout at `dir`. A claim whose
       * file the tree does not hold comes back unread and supported: an unreadable claim is
       * unchecked, never disproved.
       */
      async check(options: { dir: string; claims: Claim[] }): Promise<Checked[]> {
        if (options.claims.length === 0) return [];
        const tree = await treeOf(options.dir);
        const spent = fresh();
        const checked = await mapLimit(options.claims, IN_FLIGHT, async (claim): Promise<Checked> => {
          const code = codeAt(tree, claim.where);
          if (code === undefined) {
            return { ...claim, verdict: "supported", confidence: 0, read: false };
          }
          const answers = await ask(
            spent,
            { claim: claim.claim, where: claim.where, code },
            {
              verdict: choice(
                {
                  question: "Does `code` hold the mechanism that `claim` rests on?",
                  inspect: "`code` alone, which is the file `where` names, or a window of it around that line",
                  ignore: [
                    "Whether the problem would matter, or how bad it would be",
                    "Whether the consequence the claim predicts is spelled out anywhere",
                    "Whether the claim holds somewhere else in the codebase",
                  ],
                },
                CLAIM_VERDICTS,
              ),
            },
          );
          return {
            ...claim,
            verdict: answers.verdict.choice as Verdict,
            confidence: answers.verdict.confidence,
            read: true,
          };
        });
        noted(spent);
        return checked;
      },

      /**
       * The pass over one diff, with the checkout at `dir` holding the code it changes: every
       * window of every file judged by every probe, the strongest followed, and the findings
       * scored and routed. `about` is the pull request's own text, for the probes that hold
       * the change to what the author claims. Null when the diff holds nothing to screen.
       */
      async review(options: { dir: string; diff: string; about?: string }): Promise<Report | null> {
        const { files, tests } = changedIn(options.diff);
        if (files.length === 0) return null;
        const tree = await treeOf(options.dir);
        const graph = graphOf(tree);
        const spent = fresh();
        const pr = (options.about ?? "").slice(0, ABOUT_CHARS);
        let context = 0;

        const screened = await mapLimit(files, IN_FLIGHT, async (file) => {
          const doc = DOC.test(file.path);
          const related: Excerpt[] = doc
            ? codeFor(files, file)
            : [...relatedTo(graph, tree, file.path), ...docsFor(tree, file.patch)];
          context += related.length;
          const changedTests = doc ? [] : testSummaries(graph, tests, file.path);
          const hunks = parseHunks(file.patch).slice(0, HUNKS_EACH);
          const asked = PROBE_NAMES.filter((name) => ((PROBES[name] as { docs?: boolean }).docs === true) === doc);
          const state = {
            pr,
            file: { path: file.path, patch: file.patch },
            hunks: hunks.map((hunk, index) => ({ index, id: hunk.id, startLine: hunk.startLine, patch: hunk.patch })),
            related,
            changedTests,
          };
          const groups = chunked(Object.entries(hunkQuestions(asked, hunks)), QUESTIONS_EACH);
          const windows: Window[] = [];
          for (const group of groups) {
            const answers = await ask(spent, state, Object.fromEntries(group));
            for (const [key, answer] of Object.entries(answers)) {
              const [probe, id] = key.split("__") as [string, string];
              const hunk = hunks.find((one) => one.id === id);
              if (hunk !== undefined && "noul" in answer) windows.push({ probe, hunk, probability: answer.noul });
            }
          }
          const rated = await ask(spent, { file: state.file, related }, { tier: TIER });
          const probes: Record<string, number> = {};
          for (const name of asked) {
            probes[name] = Math.max(0, ...windows.filter((one) => one.probe === name).map((one) => one.probability));
          }
          const cells = Object.fromEntries(
            DIMENSIONS.map((dimension) => [
              dimension,
              Math.max(0, ...asked.filter((name) => PROBE_DIMENSIONS[name] === dimension).map((name) => probes[name] ?? 0)),
            ]),
          ) as Cells;
          return { file, cells, probes, windows, related, tier: rated.tier.choice as Tier };
        });

        // Every file looks a little suspect on its own. Side by side, the one that matters stands out.
        const candidates = screened
          .filter((one) => one.tier === "deep")
          .map((one) => {
            const best = one.windows
              .filter((window) => window.probe !== "testGap")
              .sort((a, b) => b.probability - a.probability);
            const shown = [...new Set(best.map((window) => window.hunk.id))].slice(0, WINDOWS_SHOWN).map((id) => best.find((window) => window.hunk.id === id)!);
            if (shown.length === 0) return undefined;
            return {
              path: one.file.path,
              probability: best[0]!.probability,
              windows: shown.map((window) => ({ line: window.hunk.startLine, suspected: PROBE_DIMENSIONS[window.probe] ?? "correctness", patch: window.hunk.patch })),
            };
          })
          .filter((one): one is NonNullable<typeof one> => one !== undefined)
          .sort((a, b) => b.probability - a.probability);
        const rank = new Map<string, number>();
        const ranks = new Map<string, Record<string, number>>();
        await mapLimit(chunked(candidates.map((one) => [one.path, one] as [string, typeof one]), RANKED_EACH), IN_FLIGHT, async (group) => {
          if (group.length < 2) {
            for (const [path] of group) {
              rank.set(path, 1);
              ranks.set(path, {});
            }
            return;
          }
          // The same comparison in two orders, so where a file sits in the list does not decide its rank.
          const orders = [group.map(([, one]) => one), [...group].reverse().map(([, one]) => one)];
          const summed = new Map<string, Record<string, number>>();
          for (const order of orders) {
            const ids = order.map((one, index) => ({ id: `c${index}`, path: one.path, windows: one.windows }));
            const options = Object.fromEntries(ids.map((one) => [one.id, one.path]));
            const asked = Object.fromEntries(
              Object.entries(RANKINGS).map(([name, question]) => [
                name,
                choice({ question, inspect: "Each candidate's windows against the other candidates', with pr for what the change claims to do" }, options),
              ]),
            );
            const answers = await ask(spent, { pr, candidates: ids }, asked);
            for (const one of ids) {
              const held = summed.get(one.path) ?? {};
              for (const [name, answer] of Object.entries(answers)) {
                held[name] = (held[name] ?? 0) + ((answer.probabilities[one.id] ?? 0) * ids.length) / orders.length;
              }
              summed.set(one.path, held);
            }
          }
          for (const [path, each] of summed) {
            ranks.set(path, each);
            rank.set(path, Math.max(...Object.values(each)));
          }
        });

        const byPath = new Map(screened.map((one) => [one.file.path, one]));
        const perConcern = Math.min(
          PER_CONCERN.most,
          Math.max(PER_CONCERN.least, Math.ceil(files.length / PER_CONCERN.filesEach)),
        );
        const inspected = probeSignals(
          screened.map(({ file, probes }) => ({ path: file.path, probes })),
          PROBE_DIMENSIONS,
          { floor: FLOOR, perProbe: perConcern },
        );

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

        const located = await mapLimit(inspected, IN_FLIGHT, (signal) => {
          const held = byPath.get(signal.path);
          return held === undefined
            ? Promise.resolve([])
            : locate(spent, signal, held.file, held.related, held.windows);
        });
        const findings = located.flat().sort((a, b) => b.severity - a.severity);

        noted(spent);

        return {
          files: files.length,
          tests: tests.length,
          context,
          floor: FLOOR,
          perConcern,
          matrix: screened.map(({ file, cells, probes, windows, tier }) => ({
            path: file.path,
            cut: file.cut,
            tier,
            cells,
            probes,
            windows: windows.map((one) => ({ probe: one.probe, line: one.hunk.startLine, probability: one.probability })),
            rank: rank.get(file.path),
            ranks: ranks.get(file.path),
          })),
          profiles,
          inspected,
          connections: screened.map(({ file, tier, related }) => ({
            path: file.path,
            tier,
            excerpts: related,
          })),
          findings,
          funnel: {
            cells: files.length * PROBE_NAMES.length,
            inspected: inspected.length,
            located: findings.length,
            routed: findings.filter((one) => one.owner !== null).length,
          },
        };
      },
    };
  },
});

import type { ViewEvent } from "@mikaelweiss/penguin-engine/protocol";

export type NodeState = "running" | "blocked" | "idle" | "quiet" | "done" | "failed";

export type Node = {
  id: string;
  parent?: string;
  label: string;
  detail?: string;
  children: string[];
  sessions: string[];
  state: NodeState;
  ended?: "ok" | "failed";
};

export type CredentialField = { name: string; label: string; secret: boolean; env?: string };

export type Attention =
  | {
      kind: "gate";
      gate?: string;
      question: string;
      schema?: Record<string, unknown>;
      node: string;
      path: string[];
    }
  | {
      kind: "credential";
      name: string;
      label: string;
      phase: "asked" | "rejected";
      reason?: string;
      url?: string;
      hint?: string;
      fields: CredentialField[];
      node: string;
      path: string[];
    };

export type Waiting = { id: string; label: string; node: string; path: string[] };

export type Entry = { seq: number; event: ViewEvent };

export type RunPhase = "live" | "done" | "stopped" | "error";

type Cell = {
  id: string;
  parent?: string;
  label: string;
  detail?: string;
  children: string[];
  sessions: string[];
  ended?: "ok" | "failed";
  running: number;
  blocked: number;
  idle: number;
  entries: Entry[];
};

type OpenGate = {
  order: number;
  gate?: string;
  question: string;
  schema?: Record<string, unknown>;
  node: string;
};

type OpenCredential = {
  order: number;
  name: string;
  label: string;
  phase: "asked" | "rejected";
  reason?: string;
  url?: string;
  hint?: string;
  fields: CredentialField[];
  node: string;
};

type OpenWait = { order: number; id: string; label: string; node: string };

const ROOT = "root";

const KINDS = new Set([
  "run",
  "state",
  "session",
  "message",
  "activity",
  "wait",
  "step",
  "fact",
  "event",
  "artifact",
  "watch",
  "agent",
  "gate",
  "credential",
]);

function labelOf(label: string, detail?: string): string {
  return detail === undefined || detail === "" ? label : `${label} (${detail})`;
}

/**
 * Transcript inclusion. One rule attributes every event to one node at apply time:
 * the event's own activity when it names a known activity, else the node of the
 * event's session when it names a known session, else the root. transcript(id)
 * returns the entries of that node and of every descendant, in apply order. The
 * root therefore holds the whole story. State and watch events are status, not
 * story, so they take a seq number and no transcript entry.
 */
export class Projection {
  private nodes = new Map<string, Cell>();
  private sessions = new Map<string, { name: string; node: string; dir: string }>();
  private sessionEntries = new Map<string, Entry[]>();
  private stepNodes = new Map<string, string>();
  private openGates = new Map<string, OpenGate>();
  private openCredentials = new Map<string, OpenCredential>();
  private openWaits = new Map<string, OpenWait>();
  private values: Record<string, string | number | boolean> = {};
  private latest: { elapsed?: boolean; diff?: string } | undefined;
  private lastState: { state: string; detail?: string } | undefined;
  private runPhase: RunPhase = "live";
  private runReason: string | undefined;
  private runResult: unknown;
  private seq = 0;
  private asks = 0;
  private runCwd: string;

  constructor(run: string, cwd: string) {
    this.runCwd = cwd;
    this.nodes.set(ROOT, {
      id: ROOT,
      label: run,
      children: [],
      sessions: [],
      running: 0,
      blocked: 0,
      idle: 0,
      entries: [],
    });
  }

  line(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    this.apply(parsed as ViewEvent);
  }

  apply(event: ViewEvent): void {
    const kind = (event as { type?: unknown }).type;
    if (typeof kind !== "string" || !KINDS.has(kind)) return;
    this.take(this.seq++, event);
  }

  node(id: string): Node | undefined {
    const cell = this.nodes.get(id);
    if (cell === undefined) return undefined;
    return {
      id: cell.id,
      ...(cell.parent === undefined ? {} : { parent: cell.parent }),
      label: cell.label,
      ...(cell.detail === undefined ? {} : { detail: cell.detail }),
      children: [...cell.children],
      sessions: [...cell.sessions],
      state: this.stateOf(cell),
      ...(cell.ended === undefined ? {} : { ended: cell.ended }),
    };
  }

  root(): Node {
    return this.node(ROOT) as Node;
  }

  tree(): Node[] {
    const out: Node[] = [];
    const walk = (id: string): void => {
      const node = this.node(id);
      if (node === undefined) return;
      out.push(node);
      for (const child of node.children) walk(child);
    };
    walk(ROOT);
    return out;
  }

  attention(): Attention[] {
    const gates = [...this.openGates.values()].map((open) => ({
      order: open.order,
      item: {
        kind: "gate" as const,
        ...(open.gate === undefined ? {} : { gate: open.gate }),
        question: open.question,
        ...(open.schema === undefined ? {} : { schema: open.schema }),
        node: open.node,
        path: this.path(open.node),
      } satisfies Attention,
    }));
    const credentials = [...this.openCredentials.values()].map((open) => ({
      order: open.order,
      item: {
        kind: "credential" as const,
        name: open.name,
        label: open.label,
        phase: open.phase,
        ...(open.reason === undefined ? {} : { reason: open.reason }),
        ...(open.url === undefined ? {} : { url: open.url }),
        ...(open.hint === undefined ? {} : { hint: open.hint }),
        fields: open.fields.map((field) => ({ ...field })),
        node: open.node,
        path: this.path(open.node),
      } satisfies Attention,
    }));
    return [...gates, ...credentials].sort((a, b) => a.order - b.order).map((row) => row.item);
  }

  waiting(): Waiting[] {
    return [...this.openWaits.values()]
      .sort((a, b) => a.order - b.order)
      .map((open) => ({ id: open.id, label: open.label, node: open.node, path: this.path(open.node) }));
  }

  sessionName(id: string): string | undefined {
    return this.sessions.get(id)?.name;
  }

  sessionNode(id: string): string {
    return this.sessions.get(id)?.node ?? ROOT;
  }

  /** The directory a session's turns run in. An unknown session reads as the run's own folder. */
  sessionDir(id: string): string {
    return this.sessions.get(id)?.dir ?? this.runCwd;
  }

  /** The distinct directories of the node's subtree, in first-seen order, never empty. */
  directories(node: string): string[] {
    const cells = new Set<string>();
    const walk = (current: Cell): void => {
      cells.add(current.id);
      for (const child of current.children) {
        const next = this.nodes.get(child);
        if (next !== undefined) walk(next);
      }
    };
    walk(this.cell(node));
    const out: string[] = [];
    for (const session of this.sessions.values()) {
      if (!cells.has(session.node)) continue;
      if (!out.includes(session.dir)) out.push(session.dir);
    }
    return out.length === 0 ? [this.runCwd] : out;
  }

  transcript(node: string): Entry[] {
    const cell = this.nodes.get(node);
    if (cell === undefined) return [];
    const out: Entry[] = [];
    const walk = (current: Cell): void => {
      out.push(...current.entries);
      for (const child of current.children) {
        const next = this.nodes.get(child);
        if (next !== undefined) walk(next);
      }
    };
    walk(cell);
    return out.sort((a, b) => a.seq - b.seq);
  }

  sessionTranscript(session: string): Entry[] {
    return [...(this.sessionEntries.get(session) ?? [])];
  }

  facts(): Record<string, string | number | boolean> {
    return { ...this.values };
  }

  watch(): { elapsed?: boolean; diff?: string } | undefined {
    return this.latest === undefined ? undefined : { ...this.latest };
  }

  runState(): { state: string; detail?: string } {
    if (this.runPhase !== "live") {
      return this.runReason === undefined
        ? { state: this.runPhase }
        : { state: this.runPhase, detail: this.runReason };
    }
    if (this.lastState === undefined) return { state: "running" };
    return { ...this.lastState };
  }

  phase(): RunPhase {
    return this.runPhase;
  }

  result(): unknown {
    return this.runResult;
  }

  private take(seq: number, event: ViewEvent): void {
    switch (event.type) {
      case "run": {
        if (event.phase !== "started") {
          this.runPhase = event.phase;
          this.runReason = event.reason;
          if (event.phase === "done") this.runResult = event.result;
          const root = this.cell(ROOT);
          root.ended = event.phase === "error" ? "failed" : "ok";
        }
        this.record(ROOT, seq, event);
        return;
      }
      case "state": {
        this.lastState = event.detail === undefined ? { state: event.state } : { state: event.state, detail: event.detail };
        return;
      }
      case "watch": {
        this.latest = {};
        if (event.elapsed !== undefined) this.latest.elapsed = event.elapsed;
        if (event.diff !== undefined) this.latest.diff = event.diff;
        return;
      }
      case "session": {
        const node = this.resolve(event.activity);
        this.sessions.set(event.id, { name: event.name, node, dir: event.dir ?? this.runCwd });
        const cell = this.cell(node);
        if (!cell.sessions.includes(event.id)) cell.sessions.push(event.id);
        this.record(node, seq, event);
        return;
      }
      case "message": {
        this.record(this.owner(undefined, event.session), seq, event);
        return;
      }
      case "activity": {
        if (event.phase === "start") {
          if (!this.nodes.has(event.id)) {
            const parent = this.resolve(event.parent);
            this.nodes.set(event.id, {
              id: event.id,
              parent,
              label: event.label,
              detail: event.detail,
              children: [],
              sessions: [],
              running: 0,
              blocked: 0,
              idle: 0,
              entries: [],
            });
            this.cell(parent).children.push(event.id);
          }
          this.record(event.id, seq, event);
          return;
        }
        const node = this.resolve(event.id);
        if (node !== ROOT) this.cell(node).ended = event.outcome;
        this.record(node, seq, event);
        return;
      }
      case "wait": {
        if (event.phase === "start") {
          const node = this.resolve(event.activity);
          if (!this.openWaits.has(event.id)) {
            this.openWaits.set(event.id, { order: this.asks++, id: event.id, label: event.label, node });
            this.bump(node, "idle", 1);
          }
          this.record(node, seq, event);
          return;
        }
        const open = this.openWaits.get(event.id);
        const node = open?.node ?? this.resolve(event.activity);
        if (open !== undefined) {
          this.openWaits.delete(event.id);
          this.bump(open.node, "idle", -1);
        }
        this.record(node, seq, event);
        return;
      }
      case "step": {
        if (event.phase === "start") {
          const node = this.resolve(event.activity);
          if (!this.stepNodes.has(event.id)) {
            this.stepNodes.set(event.id, node);
            this.bump(node, "running", 1);
          }
          this.record(node, seq, event);
          return;
        }
        const started = this.stepNodes.get(event.id);
        const node = started ?? this.resolve(event.activity);
        if (started !== undefined) {
          this.stepNodes.delete(event.id);
          this.bump(started, "running", -1);
        }
        this.record(node, seq, event);
        return;
      }
      case "fact": {
        for (const [name, value] of Object.entries(event.values)) this.values[name] = value;
        this.record(ROOT, seq, event);
        return;
      }
      case "event": {
        this.record(this.resolve(event.activity), seq, event);
        return;
      }
      case "artifact": {
        this.record(ROOT, seq, event);
        return;
      }
      case "agent": {
        const node = this.owner(event.activity, event.session);
        const entry = this.record(node, seq, event);
        const list = this.sessionEntries.get(event.session);
        if (list === undefined) this.sessionEntries.set(event.session, [entry]);
        else list.push(entry);
        return;
      }
      case "gate": {
        this.gate(seq, event);
        return;
      }
      case "credential": {
        this.credential(seq, event);
        return;
      }
    }
  }

  private gate(seq: number, event: Extract<ViewEvent, { type: "gate" }>): void {
    const id = (event as { id?: string }).id;
    const node = this.resolve(event.activity);
    if (event.phase === "asked") {
      const key = id ?? `question:${event.question}`;
      const open = this.openGates.get(key);
      if (open === undefined) {
        this.openGates.set(key, {
          order: this.asks++,
          gate: id,
          question: event.question,
          schema: event.schema,
          node,
        });
        this.bump(node, "blocked", 1);
      } else {
        if (open.node !== node) {
          this.bump(open.node, "blocked", -1);
          this.bump(node, "blocked", 1);
          open.node = node;
        }
        open.question = event.question;
        open.schema = event.schema;
      }
      this.record(node, seq, event);
      return;
    }
    const key = this.gateKey(id, event.question);
    const open = key === undefined ? undefined : this.openGates.get(key);
    if (key !== undefined && open !== undefined) {
      this.openGates.delete(key);
      this.bump(open.node, "blocked", -1);
    }
    this.record(open?.node ?? node, seq, event);
  }

  private gateKey(id: string | undefined, question: string): string | undefined {
    if (id !== undefined && this.openGates.has(id)) return id;
    const byQuestion = `question:${question}`;
    if (this.openGates.has(byQuestion)) return byQuestion;
    for (const [key, open] of this.openGates) {
      if (open.question === question) return key;
    }
    return undefined;
  }

  private credential(seq: number, event: Extract<ViewEvent, { type: "credential" }>): void {
    if (event.phase === "ready") {
      const open = this.openCredentials.get(event.name);
      if (open !== undefined) {
        this.openCredentials.delete(event.name);
        this.bump(open.node, "blocked", -1);
      }
      this.record(ROOT, seq, event);
      return;
    }
    const open = this.openCredentials.get(event.name);
    const order = open?.order ?? this.asks++;
    if (open === undefined) this.bump(ROOT, "blocked", 1);
    this.openCredentials.set(event.name, {
      order,
      name: event.name,
      label: event.label,
      phase: event.phase,
      reason: event.phase === "rejected" ? event.reason : undefined,
      url: event.url,
      hint: event.hint,
      fields: event.fields.map((field) => ({ ...field })),
      node: ROOT,
    });
    this.record(ROOT, seq, event);
  }

  private record(node: string, seq: number, event: ViewEvent): Entry {
    const entry: Entry = { seq, event };
    this.cell(node).entries.push(entry);
    return entry;
  }

  private cell(id: string): Cell {
    const found = this.nodes.get(id);
    if (found !== undefined) return found;
    return this.nodes.get(ROOT) as Cell;
  }

  private resolve(activity: string | undefined): string {
    return activity !== undefined && this.nodes.has(activity) ? activity : ROOT;
  }

  private owner(activity: string | undefined, session: string | undefined): string {
    if (activity !== undefined && this.nodes.has(activity)) return activity;
    if (session !== undefined) return this.sessionNode(session);
    return ROOT;
  }

  private bump(node: string, field: "running" | "blocked" | "idle", delta: number): void {
    let current: Cell | undefined = this.nodes.get(node) ?? this.nodes.get(ROOT);
    while (current !== undefined) {
      current[field] += delta;
      current = current.parent === undefined ? undefined : this.nodes.get(current.parent);
    }
  }

  /**
   * State precedence over the subtree, the same order the run itself reports:
   * an open step beats an open gate or credential ask, which beats an open wait.
   * With nothing open, the node's own end outcome decides, so an ended child
   * never finishes an open parent. The run phase overrides the root once the
   * run ends.
   */
  private stateOf(cell: Cell): NodeState {
    if (cell.id === ROOT && this.runPhase !== "live") {
      return this.runPhase === "error" ? "failed" : "done";
    }
    if (cell.running > 0) return "running";
    if (cell.blocked > 0) return "blocked";
    if (cell.idle > 0) return "idle";
    if (cell.ended !== undefined) return cell.ended === "ok" ? "done" : "failed";
    return "quiet";
  }

  private path(node: string): string[] {
    const out: string[] = [];
    let current = this.nodes.get(node);
    while (current !== undefined) {
      out.push(labelOf(current.label, current.detail));
      current = current.parent === undefined ? undefined : this.nodes.get(current.parent);
    }
    return out.reverse();
  }
}

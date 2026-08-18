export type ViewEvent =
  | {
      type: "run";
      phase: "started" | "done" | "stopped" | "error";
      run: string;
      reason?: string;
      result?: unknown;
    }
  | { type: "state"; state: "running" | "blocked" | "idle"; detail?: string }
  | { type: "session"; id: string; name: string; use: string; dir: string; activity?: string }
  | { type: "message"; text: string; session?: string }
  | {
      type: "activity";
      phase: "start";
      id: string;
      parent?: string;
      label: string;
      /** What tells two calls of the same label apart: a compact summary of the params. */
      detail?: string;
    }
  | { type: "activity"; phase: "end"; id: string; outcome: "ok" | "failed" }
  | { type: "wait"; phase: "start"; id: string; label: string; activity?: string }
  | { type: "wait"; phase: "end"; id: string; activity?: string }
  | { type: "step"; phase: "start"; id: string; label: string; activity?: string }
  | { type: "step"; phase: "end"; id: string; label: string; ok: boolean; activity?: string }
  | { type: "fact"; values: Record<string, string | number | boolean> }
  | {
      type: "event";
      level: "info" | "warn" | "error";
      message: string;
      data?: unknown;
      activity?: string;
    }
  | { type: "artifact"; title: string; path?: string; url?: string }
  | { type: "watch"; elapsed?: boolean; diff?: string }
  | {
      type: "agent";
      session: string;
      kind: "text" | "thinking" | "tool" | "output";
      text: string;
      /** For a tool, what it acts on: the command, the file, the pattern. */
      detail?: string;
      activity?: string;
    }
  | {
      type: "gate";
      phase: "asked";
      id: string;
      question: string;
      schema?: Record<string, unknown>;
      activity?: string;
    }
  | { type: "gate"; phase: "answered"; id: string; question: string; answer: string; activity?: string }
  | {
      type: "credential";
      phase: "asked";
      name: string;
      label: string;
      url?: string;
      hint?: string;
      fields: { name: string; label: string; secret: boolean; env?: string }[];
    }
  | {
      type: "credential";
      phase: "rejected";
      name: string;
      label: string;
      reason: string;
      where: string;
      url?: string;
      hint?: string;
      fields: { name: string; label: string; secret: boolean; env?: string }[];
    }
  | { type: "credential"; phase: "ready"; name: string; where: string };

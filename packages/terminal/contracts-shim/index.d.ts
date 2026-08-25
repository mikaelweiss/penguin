// Plain-type mirror of the t3code contract shapes the vendored terminal
// files import. Field shapes follow packages/contracts/src/terminal.ts at
// the commit in ../UPSTREAM. The penguin terminal host emits these shapes.

export type EnvironmentId = string;
export type ThreadId = string;

export type TerminalSessionStatus = "starting" | "running" | "exited" | "error";

export interface TerminalSessionSnapshot {
  threadId: string;
  terminalId: string;
  cwd: string;
  worktreePath: string | null;
  status: TerminalSessionStatus;
  pid: number | null;
  history: string;
  exitCode: number | null;
  exitSignal: number | null;
  label: string;
  updatedAt: string;
  sequence?: number;
}

export interface TerminalSummary {
  threadId: string;
  terminalId: string;
  cwd: string;
  worktreePath: string | null;
  status: TerminalSessionStatus;
  pid: number | null;
  exitCode: number | null;
  exitSignal: number | null;
  hasRunningSubprocess: boolean;
  label: string;
  updatedAt: string;
}

interface TerminalEventBase {
  threadId: string;
  terminalId: string;
  sequence?: number;
}

export type TerminalAttachStreamEvent =
  | { type: "snapshot"; snapshot: TerminalSessionSnapshot }
  | (TerminalEventBase & { type: "output"; data: string })
  | (TerminalEventBase & { type: "exited"; exitCode: number | null; exitSignal: number | null })
  | (TerminalEventBase & { type: "closed" })
  | (TerminalEventBase & { type: "error"; message: string })
  | (TerminalEventBase & { type: "cleared" })
  | (TerminalEventBase & { type: "restarted"; snapshot: TerminalSessionSnapshot })
  | (TerminalEventBase & { type: "activity"; hasRunningSubprocess: boolean; label: string });

export type TerminalMetadataStreamEvent =
  | { type: "snapshot"; terminals: readonly TerminalSummary[] }
  | { type: "upsert"; terminal: TerminalSummary }
  | { type: "remove"; threadId: string; terminalId: string };

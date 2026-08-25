// Hand-written declaration boundary for the vendored terminal. It keeps the
// vendored sources out of importers' typecheck programs; shapes mirror
// src/state/terminalSession.ts at the commit in ../UPSTREAM.
import type {
  EnvironmentId,
  TerminalAttachStreamEvent,
  TerminalMetadataStreamEvent,
  TerminalSessionSnapshot,
  TerminalSummary,
  ThreadId,
} from "@t3tools/contracts";

export interface TerminalSessionState {
  readonly summary: TerminalSummary | null;
  readonly buffer: string;
  readonly status: TerminalSessionSnapshot["status"] | "closed";
  readonly error: string | null;
  readonly hasRunningSubprocess: boolean;
  readonly updatedAt: string | null;
  readonly version: number;
}

export interface TerminalBufferState {
  readonly buffer: string;
  readonly status: TerminalSessionSnapshot["status"] | "closed";
  readonly error: string | null;
  readonly updatedAt: string | null;
  readonly version: number;
}

export interface KnownTerminalSessionTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly terminalId: string;
}

export interface KnownTerminalSession {
  readonly target: KnownTerminalSessionTarget;
  readonly state: TerminalSessionState;
}

export declare function selectRunningSubprocessTerminalIds(
  sessions: ReadonlyArray<KnownTerminalSession>,
): ReadonlyArray<string>;

export declare const EMPTY_TERMINAL_BUFFER_STATE: TerminalBufferState;
export declare const EMPTY_TERMINAL_SESSION_STATE: TerminalSessionState;
export declare const DEFAULT_MAX_TERMINAL_BUFFER_BYTES: number;

export declare function terminalBufferStateFromSnapshot(
  snapshot: TerminalSessionSnapshot,
  maxBufferBytes: number,
): TerminalBufferState;

export declare function combineTerminalSessionState(
  summary: TerminalSummary | null,
  buffer: TerminalBufferState,
): TerminalSessionState;

export declare function applyTerminalAttachStreamEvent(
  current: TerminalBufferState,
  event: TerminalAttachStreamEvent,
  maxBufferBytes?: number,
): TerminalBufferState;

export declare function applyTerminalMetadataStreamEvent(
  current: ReadonlyArray<TerminalSummary>,
  event: TerminalMetadataStreamEvent,
): ReadonlyArray<TerminalSummary>;

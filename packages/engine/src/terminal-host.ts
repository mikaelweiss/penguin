// The terminal panel's pty host. The app spawns `bun terminal-host.ts`, reads
// the port from the first stdout line, and attaches per run over WebSocket
// with the t3code attach-stream shapes. The host exits when stdin closes.
import path from "node:path";
import { spawn as spawnPty } from "bun-pty";

type PtyExit = { exitCode: number; signal?: number | string };

type Pty = {
  readonly pid: number;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: PtyExit) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
};

type PtyOptions = {
  name: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
};

// bun-pty's declaration files use extensionless relative imports, which do not
// resolve under nodenext, so its types silently decay to any. This local
// signature restores them.
const spawn: (file: string, args: string[], options: PtyOptions) => Pty = spawnPty;

const HISTORY_LIMIT = 512 * 1024;

type Attachment = { send(text: string): void };

type Session = {
  id: string;
  cwd: string;
  proc: Pty | undefined;
  status: "running" | "exited";
  exitCode: number | null;
  exitSignal: number | null;
  history: string;
  updatedAt: string;
  attachments: Set<Attachment>;
};

const sessions = new Map<string, Session>();

function shellCommand(): { file: string; args: string[] } {
  const fallback = process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
  const file = process.env["SHELL"] ?? fallback;
  return { file, args: process.platform === "darwin" ? ["-l"] : [] };
}

function shellEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env["COLORTERM"] = "truecolor";
  return env;
}

function capHistory(history: string): string {
  if (history.length <= HISTORY_LIMIT) return history;
  let start = history.length - HISTORY_LIMIT;
  const code = history.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start += 1;
  return history.slice(start);
}

function snapshot(session: Session) {
  return {
    threadId: session.id,
    terminalId: "main",
    cwd: session.cwd,
    worktreePath: null,
    status: session.status,
    pid: session.proc?.pid ?? null,
    history: session.history,
    exitCode: session.exitCode,
    exitSignal: session.exitSignal,
    label: path.basename(shellCommand().file),
    updatedAt: session.updatedAt,
  };
}

function broadcast(session: Session, event: unknown): void {
  const text = JSON.stringify(event);
  for (const attachment of session.attachments) attachment.send(text);
}

function start(session: Session, cols: number, rows: number): void {
  const { file, args } = shellCommand();
  const proc = spawn(file, args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd: session.cwd,
    env: shellEnv(),
  });
  session.proc = proc;
  session.status = "running";
  session.exitCode = null;
  session.exitSignal = null;
  session.history = "";
  session.updatedAt = new Date().toISOString();
  proc.onData((data) => {
    if (session.proc !== proc) return;
    session.history = capHistory(session.history + data);
    session.updatedAt = new Date().toISOString();
    broadcast(session, { type: "output", threadId: session.id, terminalId: "main", data });
  });
  proc.onExit((event) => {
    if (session.proc !== proc) return;
    session.status = "exited";
    session.exitCode = event.exitCode;
    session.exitSignal = typeof event.signal === "number" ? event.signal : null;
    session.updatedAt = new Date().toISOString();
    broadcast(session, {
      type: "exited",
      threadId: session.id,
      terminalId: "main",
      exitCode: session.exitCode,
      exitSignal: session.exitSignal,
    });
  });
}

function respawn(session: Session, cwd: string, cols: number, rows: number): void {
  const old = session.proc;
  session.proc = undefined;
  if (old !== undefined && session.status === "running") old.kill("SIGHUP");
  session.cwd = cwd;
  start(session, cols, rows);
  broadcast(session, {
    type: "restarted",
    threadId: session.id,
    terminalId: "main",
    snapshot: snapshot(session),
  });
}

type Open = { id: string; cwd: string; cols: number; rows: number };

function attach(open: Open): Session {
  let session = sessions.get(open.id);
  if (session === undefined) {
    session = {
      id: open.id,
      cwd: open.cwd,
      proc: undefined,
      status: "exited",
      exitCode: null,
      exitSignal: null,
      history: "",
      updatedAt: new Date().toISOString(),
      attachments: new Set(),
    };
    sessions.set(open.id, session);
    start(session, open.cols, open.rows);
  } else if (session.cwd !== open.cwd || session.status !== "running") {
    respawn(session, open.cwd, open.cols, open.rows);
  }
  return session;
}

type Inbound = { type: "input"; data: string } | { type: "resize"; cols: number; rows: number };

const server = Bun.serve<Open>({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname !== "/attach") return new Response("not found", { status: 404 });
    const id = url.searchParams.get("id");
    const cwd = url.searchParams.get("cwd");
    if (id === null || id === "" || cwd === null || cwd === "") {
      return new Response("id and cwd are required", { status: 400 });
    }
    const cols = Number(url.searchParams.get("cols")) || 80;
    const rows = Number(url.searchParams.get("rows")) || 24;
    if (server.upgrade(request, { data: { id, cwd, cols, rows } })) return;
    return new Response("upgrade failed", { status: 400 });
  },
  websocket: {
    open(ws) {
      const session = attach(ws.data);
      session.attachments.add(ws);
      ws.send(JSON.stringify({ type: "snapshot", snapshot: snapshot(session) }));
    },
    message(ws, message) {
      const session = sessions.get(ws.data.id);
      if (session === undefined || session.proc === undefined) return;
      let inbound: Inbound;
      try {
        inbound = JSON.parse(String(message)) as Inbound;
      } catch {
        return;
      }
      if (inbound.type === "input" && typeof inbound.data === "string") {
        session.proc.write(inbound.data);
      } else if (
        inbound.type === "resize" &&
        Number.isInteger(inbound.cols) &&
        Number.isInteger(inbound.rows) &&
        inbound.cols > 0 &&
        inbound.rows > 0
      ) {
        session.proc.resize(inbound.cols, inbound.rows);
      }
    },
    close(ws) {
      sessions.get(ws.data.id)?.attachments.delete(ws);
    },
  },
});

console.log(JSON.stringify({ port: server.port }));

async function waitForParent(): Promise<void> {
  for await (const chunk of Bun.stdin.stream()) {
    void chunk;
  }
}

await waitForParent();
for (const session of sessions.values()) {
  if (session.proc !== undefined && session.status === "running") session.proc.kill("SIGHUP");
}
process.exit(0);

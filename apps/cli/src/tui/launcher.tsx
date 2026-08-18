import {
    coerce,
    installed,
    listed,
    load,
    messageOf,
    PenguinError,
    searchedWorkflows,
    short,
    unfilled,
    validate,
    writeEnv,
    type Asked,
    type ParamsSchema,
    type WorkflowFound,
} from "@mikaelweiss/penguin-engine/catalog";
import { allocateRun, attachmentsDir, discardRun, finishRun, startRun } from "@mikaelweiss/penguin-engine/run";
import { decodePasteBytes, type KeyEvent } from "@opentui/core";
import { useKeyboard, usePaste, useTerminalDimensions } from "@opentui/react";
import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { agentLine, started } from "../attach/attach.ts";
import { pasteImage } from "../machine/clipboard.ts";
import { Editor } from "./editor.ts";
import { Choices, InputBar } from "./input.tsx";
import { cut } from "./text.ts";
import { ink } from "./theme.ts";

export type Started = { name: string; agent: string };

type Launch = {
  name: string;
  dir: string;
  source: string;
  label: string;
  agent: string;
  schema: ParamsSchema;
  values: Record<string, unknown>;
  queue: Asked[];
};

type Phase =
  | { kind: "list" }
  | { kind: "loading" }
  | { kind: "starting" }
  | { kind: "ask"; param: Asked }
  | { kind: "pick"; param: Asked; cursor: number };

/** Every workflow, the params the chosen one needs, and the run that comes out. */
export function Launcher({
  onStarted,
  onClose,
}: {
  onStarted(started: Started): void;
  onClose(): void;
}): ReactNode {
  const size = useTerminalDimensions();
  const [entries, setEntries] = useState<WorkflowFound[]>([]);
  const [cursor, setCursor] = useState(0);
  const [phase, setPhase] = useState<Phase>({ kind: "list" });
  const [warn, setWarn] = useState("");
  const [editor] = useState(() => new Editor());
  const [, bump] = useReducer((count: number) => count + 1, 0);
  const held = useRef<Launch | undefined>(undefined);
  const live = useRef(true);

  useEffect(() => {
    let gone = false;
    void listed(process.cwd()).then((found) => {
      if (!gone) setEntries(found);
    });
    return () => {
      gone = true;
    };
  }, []);

  const at = Math.max(0, Math.min(entries.length - 1, cursor));

  /** A directory nothing finished is not a run, so leaving takes it with it. */
  const leave = (): void => {
    const launch = held.current;
    held.current = undefined;
    live.current = false;
    if (launch !== undefined) discardRun(launch.dir);
  };

  useEffect(() => () => leave(), []);

  const cancel = (): void => {
    leave();
    onClose();
  };

  const fail = (error: unknown, launch: Launch | undefined): void => {
    held.current = undefined;
    if (launch !== undefined) discardRun(launch.dir);
    if (!live.current) return;
    setWarn(messageOf(error));
    setPhase({ kind: "list" });
  };

  /** The view opens on a run the process already holds, which reads as live. */
  const finish = async (launch: Launch): Promise<void> => {
    let pid: number;
    try {
      validate(launch.schema, launch.values);
      finishRun(launch.dir, launch.source, launch.values);
      pid = startRun(launch.name);
    } catch (error) {
      return fail(error, launch);
    }
    setWarn("");
    setPhase({ kind: "starting" });
    const took = await started(launch.dir, pid);
    if (!live.current) return;
    held.current = undefined;
    if (!took) {
      return fail(new PenguinError(`the run process for ${launch.name} died before it started`), launch);
    }
    onStarted({ name: launch.name, agent: launch.agent });
  };

  const ask = (launch: Launch): void => {
    const param = launch.queue[0];
    if (param === undefined) return void finish(launch);
    setWarn("");
    setPhase(param.choices.length > 0 ? { kind: "pick", param, cursor: 0 } : { kind: "ask", param });
  };

  const take = (launch: Launch, param: Asked, value?: unknown): void => {
    if (value !== undefined) launch.values[param.name] = value;
    launch.queue = launch.queue.slice(1);
    ask(launch);
  };

  /** The run directory exists before the questions, so a pasted image lands in its attachments. */
  const begin = async (entry: WorkflowFound): Promise<void> => {
    setWarn("");
    setPhase({ kind: "loading" });
    let launch: Launch | undefined;
    try {
      const definition = await load(entry.file);
      const queue = unfilled(definition.params, {});
      const found = await installed(process.cwd());
      writeEnv(process.cwd(), found);
      // Nothing between the claim and the assignment throws, so nothing leaks the directory.
      const { name, dir } = allocateRun(entry.file);
      launch = {
        name,
        dir,
        source: entry.file,
        label: entry.name,
        agent: agentLine(found),
        schema: definition.params,
        values: {},
        queue,
      };
      if (!live.current) return discardRun(dir);
      held.current = launch;
      ask(launch);
    } catch (error) {
      fail(error, launch);
    }
  };

  const takeImage = async (launch: Launch): Promise<void> => {
    const got = await pasteImage(attachmentsDir(launch.dir));
    if ("path" in got) {
      editor.insert(got.path);
      setWarn("");
    } else {
      setWarn(got.warn);
    }
    bump();
  };

  const listKey = (key: KeyEvent): void => {
    const last = Math.max(0, entries.length - 1);
    if (key.name === "up" || key.name === "k") return setCursor(Math.max(0, at - 1));
    if (key.name === "down" || key.name === "j") return setCursor(Math.min(last, at + 1));
    if (key.name === "left" || key.name === "h") return setCursor(0);
    if (key.name === "right" || key.name === "l") return setCursor(last);
    if (key.name === "return" || key.name === "enter") {
      const entry = entries[at];
      if (entry === undefined) return;
      void begin(entry);
    }
  };

  const pickKey = (key: KeyEvent, param: Asked, cursor: number, launch: Launch): void => {
    const labels = labelsOf(param);
    const step = (delta: number): void =>
      setPhase({ kind: "pick", param, cursor: (cursor + labels.length + delta) % labels.length });
    if (key.name === "up" || key.name === "k") return step(-1);
    if (key.name === "down" || key.name === "j") return step(1);
    if (key.name === "return" || key.name === "enter") {
      return take(launch, param, param.choices[cursor]);
    }
  };

  const askKey = (key: KeyEvent, param: Asked, launch: Launch): void => {
    if (key.ctrl) {
      if (key.name === "v") return void takeImage(launch);
      if (key.name === "a") editor.head();
      else if (key.name === "e") editor.tail();
      else if (key.name === "u") editor.killLeft();
      else if (key.name === "k") editor.killRight();
      else if (key.name === "w") editor.killWord();
      else return;
      return bump();
    }
    if (key.name === "return" || key.name === "enter") {
      const answer = editor.take();
      if (answer === "") {
        if (param.optional) return take(launch, param);
        return bump();
      }
      try {
        return take(launch, param, coerce(param.kind, param.name, answer));
      } catch (error) {
        setWarn(messageOf(error));
        return bump();
      }
    }
    if (key.name === "backspace") editor.backspace();
    else if (key.name === "delete") editor.delete();
    else if (key.name === "left") editor.left();
    else if (key.name === "right") editor.right();
    else if (key.name === "home") editor.head();
    else if (key.name === "end") editor.tail();
    else {
      const typed = printable(key);
      if (typed === undefined) return;
      editor.insert(typed);
    }
    bump();
  };

  useKeyboard((key: KeyEvent) => {
    if (key.eventType === "release") return;
    if (key.name === "escape" || (key.ctrl && key.name === "c")) return cancel();
    if (phase.kind === "loading" || phase.kind === "starting") return;
    if (phase.kind === "list") return listKey(key);
    const launch = held.current;
    if (launch === undefined) return;
    if (phase.kind === "pick") return pickKey(key, phase.param, phase.cursor, launch);
    askKey(key, phase.param, launch);
  });

  usePaste((event) => {
    if (phase.kind !== "ask") return;
    editor.paste(decodePasteBytes(event.bytes));
    bump();
  });

  const chosen = held.current;
  const title = chosen === undefined ? " start a workflow" : ` start a workflow: ${chosen.label}`;
  return (
    <box style={{ flexDirection: "column", width: size.width, height: size.height }}>
      <box style={{ flexDirection: "column", flexGrow: 1 }}>
        <text fg={ink.dim}>{cut(title, size.width)}</text>
        {phase.kind === "list" || phase.kind === "loading" ? (
          <List entries={entries} at={at} width={size.width} />
        ) : null}
      </box>
      <Bottom phase={phase} editor={editor} empty={entries.length === 0} warn={warn} width={size.width} />
    </box>
  );
}

function List({
  entries,
  at,
  width,
}: {
  entries: WorkflowFound[];
  at: number;
  width: number;
}): ReactNode {
  if (entries.length === 0) {
    const places = searchedWorkflows(process.cwd()).map(short).join(" or ");
    return <text fg={ink.faint}>{cut(`  no workflow file in ${places}`, width)}</text>;
  }
  return (
    <box style={{ flexDirection: "column" }}>
      {entries.map((entry, index) => (
        <box key={entry.file} style={{ flexDirection: "column", flexShrink: 0 }}>
          <text>
            <span fg={index === at ? ink.accent : ink.faint}>{index === at ? " > " : "   "}</span>
            <span fg={index === at ? ink.text : ink.dim}>
              {cut(`${entry.name}  ${entry.params.join(" ")}`.trimEnd(), width - 4)}
            </span>
          </text>
          {entry.description === "" ? null : (
            <text fg={ink.faint}>{cut(`     ${oneLine(entry.description)}`, width)}</text>
          )}
        </box>
      ))}
    </box>
  );
}

function Bottom({
  phase,
  editor,
  empty,
  warn,
  width,
}: {
  phase: Phase;
  editor: Editor;
  empty: boolean;
  warn: string;
  width: number;
}): ReactNode {
  if (phase.kind === "loading") return <text fg={ink.dim}>{cut("  reading the workflow", width)}</text>;
  if (phase.kind === "starting") return <text fg={ink.dim}>{cut("  starting the run", width)}</text>;
  if (phase.kind === "pick") {
    return (
      <Choices
        title={question(phase.param)}
        choices={labelsOf(phase.param).map((label) => ({ label }))}
        cursor={phase.cursor}
        chosen={[]}
        many={false}
        keys="arrows move, enter confirms, esc cancels"
        width={width}
      />
    );
  }
  if (phase.kind === "ask") {
    return (
      <box style={{ flexDirection: "column", flexShrink: 0 }}>
        <text fg={ink.warn}>{cut(question(phase.param), width)}</text>
        {phase.param.optional ? <text fg={ink.dim}>{cut("  enter skips", width)}</text> : null}
        <InputBar
          editor={editor}
          prompt=">"
          hint={warn === "" ? "esc cancels, ctrl-u clears the line" : warn}
          focused={true}
          width={width}
        />
      </box>
    );
  }
  const hint = empty ? "esc closes" : "arrows or hjkl move, enter starts, esc closes";
  return (
    <box style={{ flexDirection: "column", flexShrink: 0 }}>
      {said(warn).map((line, index) => (
        <text key={`${index}:${line}`} fg={ink.bad}>
          {cut(`  ${line}`, width)}
        </text>
      ))}
      <text fg={ink.faint}>{cut(`  ${hint}`, width)}</text>
    </box>
  );
}

/** A message names the param that failed on its own line, so every line shows. */
function said(warn: string): string[] {
  return warn.split("\n").filter((line) => line.trim() !== "");
}

function question(param: Asked): string {
  return `--${param.name} <${param.hint}>`;
}

function labelsOf(param: Asked): string[] {
  return param.optional ? [...param.choices, "skip"] : param.choices;
}

function oneLine(text: string): string {
  return text.split("\n").find((line) => line.trim() !== "") ?? "";
}

function printable(key: KeyEvent): string | undefined {
  if (key.ctrl || key.meta) return undefined;
  const sequence = key.sequence;
  if (sequence.length !== 1) return undefined;
  const code = sequence.codePointAt(0) ?? 0;
  if (code < 0x20 || code === 0x7f) return undefined;
  return sequence;
}

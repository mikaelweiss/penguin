import { decodePasteBytes, type KeyEvent } from "@opentui/core";
import { useKeyboard, usePaste, useRenderer, useTerminalDimensions } from "@opentui/react";
import {
  attachmentsDir,
  credentialFile,
  credentials,
  holder,
  runDir,
} from "@mikaelweiss/penguin-engine";
import { type Attention, controlFor, deliver, Feed, provide } from "@mikaelweiss/penguin-viewer";
import { spawn } from "node:child_process";
import { type ReactNode, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { pasteImage } from "./clipboard.ts";
import { type Ask, type Fix, fixes, notes, why } from "./credential.ts";
import { Editor } from "./editor.ts";
import { Choices, type Copying, CopyList, Fields, InputBar, useCopy } from "./input.tsx";
import { openEditor } from "./open-editor.ts";
import { brief, statusLine } from "./status.ts";
import { cut, fit } from "./text.ts";
import { ink } from "./theme.ts";
import { Transcript } from "./transcript.tsx";
import { type Selection, Tree, treeKeys, treeRows } from "./tree.tsx";

const WATCHDOG = 500;
const SPIN = 200;
const SAMPLE = 1000;
export const PANE = 34;

export type Left = { back: boolean; code: number; note?: string };

type Pick = { key: string; cursor: number; chosen: number[] };

type Form = { key: string; at: number; values: Record<string, string>; buffer: string; retype: boolean };

const NO_PICK: Pick = { key: "", cursor: 0, chosen: [] };

const NO_FORM: Form = { key: "", at: 0, values: {}, buffer: "", retype: false };

/** One run on the whole screen: its tree, the selected transcript, and the input. */
export function RunView({
  name,
  agent,
  node,
  ownsExit,
  onLeave,
}: {
  name: string;
  agent: string;
  node?: string;
  ownsExit: boolean;
  onLeave(left: Left): void;
}): ReactNode {
  const dir = useMemo(() => runDir(name), [name]);
  const feed = useMemo(() => {
    const made = new Feed(name, dir);
    made.read();
    return made;
  }, [name, dir]);
  const [, bump] = useReducer((count: number) => count + 1, 0);
  const size = useTerminalDimensions();
  const renderer = useRenderer();
  const [editor] = useState(() => new Editor());
  const [selected, setSelected] = useState<Selection>({ kind: "node", id: node ?? "root" });
  const [focus, setFocus] = useState<"input" | "tree">("input");
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const [dropped, setDropped] = useState<Set<string>>(() => new Set());
  const held = useRef<{ pick: Pick; form: Form }>({ pick: NO_PICK, form: NO_FORM });
  const pick = held.current.pick;
  const form = held.current.form;
  const setPick = (next: Pick): void => {
    held.current.pick = next;
    bump();
  };
  const setForm = (next: Form): void => {
    held.current.form = next;
    bump();
  };
  const [alive, setAlive] = useState(() => holder(dir) !== undefined);
  const [frame, setFrame] = useState(0);
  const [since, setSince] = useState(() => Date.now());
  const [diff, setDiff] = useState("");
  const [note, setNote] = useState("");
  const copying = useCopy(setNote);

  useEffect(() => {
    const off = feed.follow(bump);
    return () => {
      off();
      feed.stop();
    };
  }, [feed]);

  useEffect(() => {
    if (!alive) return;
    const timer = setInterval(() => {
      if (holder(dir) !== undefined) return;
      feed.pump();
      setAlive(false);
    }, WATCHDOG);
    timer.unref?.();
    return () => clearInterval(timer);
  }, [alive, dir, feed]);

  useEffect(() => {
    if (!alive) return;
    const timer = setInterval(() => setFrame((count) => count + 1), SPIN);
    timer.unref?.();
    return () => clearInterval(timer);
  }, [alive]);

  const projection = feed.projection;
  const watch = projection.watch();
  const where = watch?.diff;

  useEffect(() => {
    setSince(Date.now());
    setDiff("");
  }, [watch?.elapsed, where]);

  useEffect(() => {
    if (where === undefined) return;
    let gone = false;
    const sample = async (): Promise<void> => {
      const text = await gitShortstat(where);
      if (!gone) setDiff(text);
    };
    void sample();
    const timer = setInterval(() => void sample(), SAMPLE);
    timer.unref?.();
    return () => {
      gone = true;
      clearInterval(timer);
    };
  }, [where]);

  const phase = projection.phase();
  const ended = phase !== "live" || !alive;
  const place = ended ? "tree" : focus;
  const rows = treeRows(projection, closed);
  const nodeId = selected.kind === "node" ? selected.id : projection.sessionNode(selected.id);
  const attention = projection.attention();
  const need = attention.find((one) => one.node === nodeId && !dropped.has(keyOf(one)));
  const gate = need?.kind === "gate" ? need : undefined;
  const shape = gate?.schema === undefined ? undefined : controlFor(gate.schema);
  const list = shape !== undefined && "list" in shape ? shape : undefined;
  const asked = need?.kind === "credential" ? need : undefined;
  const entries =
    selected.kind === "session" ? projection.sessionTranscript(selected.id) : projection.transcript(selected.id);
  const width = Math.max(20, size.width - PANE - 3);
  const control = asked !== undefined || list !== undefined;
  const keys = !ended && place === "tree" && !control ? treeKeys(PANE) : [];
  const room = Math.max(1, size.height - 2 - keys.length);

  const leave = (left: Left): void => {
    onLeave(left);
  };

  const stopRun = (): void => {
    const pid = holder(dir);
    if (pid === undefined) return leave({ back: true, code: 130 });
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      leave({ back: true, code: 130 });
    }
  };

  useEffect(() => {
    if (!ended || !ownsExit) return;
    leave(farewell(name, projection.phase(), projection.result(), projection.runState().detail, alive));
  }, [ended, ownsExit, name, alive]);

  const move = (step: number): void => {
    const at = rows.findIndex((row) => row.kind === selected.kind && row.id === selected.id);
    const next = rows[Math.max(0, Math.min(rows.length - 1, (at === -1 ? 0 : at) + step))];
    if (next !== undefined) setSelected({ kind: next.kind, id: next.id });
    setNote("");
  };

  const fold = (open: boolean): void => {
    if (selected.kind !== "node") return;
    setClosed((was) => {
      const next = new Set(was);
      if (open) next.delete(selected.id);
      else next.add(selected.id);
      return next;
    });
  };

  const drop = (): void => {
    if (need === undefined) return;
    const key = keyOf(need);
    setDropped((was) => new Set(was).add(key));
  };

  const send = (text: string): void => {
    if (text === "") return;
    const to: { session?: string; gate?: string } = {};
    if (gate !== undefined) to.gate = gate.gate;
    else if (selected.kind === "session") to.session = selected.id;
    deliver(dir, text, to);
  };

  const answerFrom = (choices: string[], chosen: number[]): void => {
    const text = chosen.map((index) => choices[index] ?? "").filter((label) => label !== "").join(", ");
    if (text === "") return;
    send(text);
  };

  const takeImage = async (): Promise<void> => {
    const got = await pasteImage(attachmentsDir(dir));
    if ("path" in got) {
      editor.insert(got.path);
      setNote("");
    } else {
      setNote(got.warn);
    }
    bump();
  };

  const startCopy = (): void => {
    copying.start(
      selected.kind === "session" ? [projection.sessionDir(selected.id)] : projection.directories(selected.id),
    );
  };

  const applyFix = async (fix: Fix, refused: Ask): Promise<void> => {
    if (fix === "stop") return stopRun();
    if (fix === "reset") {
      credentials.forget(refused.name);
      setForm({ key: keyOf(refused), at: 0, values: {}, buffer: "", retype: true });
      return;
    }
    if (fix === "edit") {
      credentials.seed(
        refused.name,
        refused.fields.map((field) => field.name),
      );
      renderer.suspend();
      try {
        await openEditor(credentialFile(refused.name));
      } finally {
        renderer.resume();
      }
    }
    drop();
    provide(dir, refused.name);
  };

  const fieldKey = (key: KeyEvent, wanted: Ask): void => {
    const now = held.current.form;
    const state = now.key === keyOf(wanted) ? now : { ...NO_FORM, key: keyOf(wanted), retype: now.retype };
    const field = wanted.fields[state.at];
    if (field === undefined) return;
    if (key.name === "escape") return setForm({ ...state, buffer: "" });
    if (key.name === "backspace") return setForm({ ...state, buffer: state.buffer.slice(0, -1) });
    if (key.name === "return" || key.name === "enter") {
      if (state.buffer.trim() === "") return;
      const values = { ...state.values, [field.name]: state.buffer.trim() };
      const next = wanted.fields[state.at + 1];
      if (next === undefined) {
        credentials.save(wanted.name, values);
        provide(dir, wanted.name);
        drop();
        setForm(NO_FORM);
        return;
      }
      setForm({ ...state, at: state.at + 1, values, buffer: "" });
      return;
    }
    const typed = printable(key);
    if (typed !== undefined) setForm({ ...state, buffer: state.buffer + typed });
  };

  const choiceKey = (
    key: KeyEvent,
    what: string,
    choices: string[],
    many: boolean,
    take: (chosen: number[]) => void,
  ): void => {
    const now = held.current.pick;
    const state = now.key === what ? now : { ...NO_PICK, key: what };
    const step = (delta: number): void => {
      const cursor = (state.cursor + choices.length + delta) % choices.length;
      setPick({ ...state, cursor });
    };
    if (key.name === "up" || key.name === "k") return step(-1);
    if (key.name === "down" || key.name === "j") return step(1);
    if (key.name === "space" && many) {
      const chosen = state.chosen.includes(state.cursor)
        ? state.chosen.filter((index) => index !== state.cursor)
        : [...state.chosen, state.cursor].sort((left, right) => left - right);
      return setPick({ ...state, chosen });
    }
    if (key.name === "escape") {
      setPick(NO_PICK);
      setFocus("input");
      return drop();
    }
    if (key.name === "return" || key.name === "enter") {
      take(many ? state.chosen : [state.cursor]);
      setPick(NO_PICK);
    }
  };

  const treeKey = (key: KeyEvent): void => {
    if (key.ctrl || key.meta) return;
    if (key.name === "q") return leave({ back: true, code: 0 });
    if (key.name === "escape") return setFocus("input");
    if (key.name === "up" || key.name === "k") return move(-1);
    if (key.name === "down" || key.name === "j") return move(1);
    if (key.name === "left" || key.name === "h") return fold(false);
    if (key.name === "right" || key.name === "l") return fold(true);
    if (key.name === "y") return startCopy();
    if (key.name === "return" || key.name === "enter") return fold(closed.has(selected.id));
  };

  const editKey = (key: KeyEvent): void => {
    if (key.ctrl) {
      if (key.name === "v") {
        void takeImage();
        return;
      }
      if (key.name === "a") editor.head();
      else if (key.name === "e") editor.tail();
      else if (key.name === "u") editor.clear();
      else if (key.name === "k") editor.killRight();
      else if (key.name === "w") editor.killWord();
      else if (key.name === "left" || key.name === "b") editor.wordLeft();
      else if (key.name === "right" || key.name === "f") editor.wordRight();
      else return;
      bump();
      return;
    }
    if (key.meta) {
      if (key.name === "b" || key.name === "left") editor.wordLeft();
      else if (key.name === "f" || key.name === "right") editor.wordRight();
      else if (key.name === "backspace") editor.killWord();
      else return;
      bump();
      return;
    }
    if (key.name === "backspace") editor.backspace();
    else if (key.name === "delete") editor.delete();
    else if (key.name === "home") editor.head();
    else if (key.name === "end") editor.tail();
    else {
      const typed = printable(key);
      if (typed === undefined) return;
      editor.insert(typed);
    }
    bump();
  };

  const typeKey = (key: KeyEvent): void => {
    if (!key.ctrl && !key.meta) {
      if (key.name === "return" || key.name === "enter") {
        send(editor.take());
        return bump();
      }
      if (key.name === "escape") return setFocus("tree");
      if (key.name === "left") {
        editor.left();
        return bump();
      }
      if (key.name === "right") {
        editor.right();
        return bump();
      }
      if (key.name === "up" || key.name === "down") {
        editor.recall(key.name === "up" ? -1 : 1);
        return bump();
      }
    }
    editKey(key);
  };

  const pickState = (wanted: Attention, options: { list: string[] }): Pick => {
    const what = pickKey(wanted, options);
    const now = held.current.pick;
    return now.key === what ? now : { ...NO_PICK, key: what };
  };

  const startTyping = (wanted: Attention, options: { list: string[] }): void => {
    setPick({ ...pickState(wanted, options), cursor: options.list.length });
  };

  const gateKey = (key: KeyEvent, wanted: Attention, options: { list: string[]; many: boolean }): void => {
    const state = pickState(wanted, options);
    const rows = options.list.length + 1;
    const cursor = Math.min(state.cursor, rows - 1);
    const typing = cursor === options.list.length;
    if (key.name === "up" || key.name === "down") {
      const step = key.name === "up" ? -1 : 1;
      return setPick({ ...state, cursor: (cursor + rows + step) % rows });
    }
    if (key.name === "escape") {
      if (typing && !editor.empty) {
        editor.clear();
        return bump();
      }
      setPick(NO_PICK);
      setFocus("input");
      return drop();
    }
    if (key.name === "return" || key.name === "enter") {
      if (typing) {
        if (editor.empty) return;
        send(editor.take());
        return setPick(NO_PICK);
      }
      answerFrom(options.list, options.many ? state.chosen : [cursor]);
      return setPick(NO_PICK);
    }
    if (typing) {
      if (!key.ctrl && !key.meta) {
        if (key.name === "left") {
          editor.left();
          return bump();
        }
        if (key.name === "right") {
          editor.right();
          return bump();
        }
      }
      editKey(key);
      return;
    }
    if (key.name === "space" && options.many) {
      const chosen = state.chosen.includes(cursor)
        ? state.chosen.filter((index) => index !== cursor)
        : [...state.chosen, cursor].sort((left, right) => left - right);
      return setPick({ ...state, chosen, cursor });
    }
    if (!inserts(key)) return;
    editKey(key);
    startTyping(wanted, options);
  };

  useKeyboard((key: KeyEvent) => {
    if (key.eventType === "release") return;
    if (key.ctrl && key.name === "c") return stopRun();
    if (copying.isOpen()) return copying.key(key);
    if (!ended) {
      if (asked !== undefined) {
        if (asked.phase === "rejected" && !(form.key === keyOf(asked) && form.retype)) {
          const list = fixes(asked.name);
          return choiceKey(
            key,
            keyOf(asked),
            list.map((one) => one.label),
            false,
            (chosen) => {
              const fix = list[chosen[0] ?? 0]?.fix;
              if (fix !== undefined) void applyFix(fix, asked);
            },
          );
        }
        return fieldKey(key, asked);
      }
      if (list !== undefined && gate !== undefined) return gateKey(key, gate, list);
      if (key.ctrl && key.name === "v") {
        setFocus("input");
        return void takeImage();
      }
    }
    if (place === "input") return typeKey(key);
    treeKey(key);
  });

  usePaste((event) => {
    if (ended || copying.isOpen() || asked !== undefined) return;
    editor.paste(decodePasteBytes(event.bytes));
    setFocus("input");
    if (list !== undefined && gate !== undefined) return startTyping(gate, list);
    bump();
  });

  const state = ended ? endedState(projection.phase(), alive) : projection.runState();
  const status = statusLine({
    state: state.state,
    ...(state.detail === undefined ? {} : { detail: state.detail }),
    ...(watch?.elapsed === true && !ended ? { running: Date.now() - since } : {}),
    diff,
    facts: projection.facts(),
  });

  return (
    <box style={{ flexDirection: "column", width: size.width, height: size.height }}>
      <box style={{ flexDirection: "row", flexGrow: 1 }}>
        <box
          style={{
            flexDirection: "column",
            width: PANE,
            border: ["right"],
            borderColor: ink.border,
            flexShrink: 0,
            overflow: "hidden",
          }}
        >
          <text fg={ink.dim} style={{ flexShrink: 0 }}>
            {cut(` ${name}  ${agent}`, PANE)}
          </text>
          <box style={{ flexDirection: "column", flexGrow: 1, flexBasis: 0, minHeight: 1, overflow: "hidden" }}>
            <Tree rows={rows} selected={selected} frame={frame} width={PANE - 1} height={room} />
          </box>
          {keys.length > 0 ? (
            <box style={{ flexDirection: "column", flexShrink: 0 }}>
              {keys.map((line) => (
                <text key={line} fg={ink.faint}>
                  {line}
                </text>
              ))}
            </box>
          ) : null}
        </box>
        <box style={{ flexDirection: "column", flexGrow: 1, paddingLeft: 1, overflow: "hidden" }}>
          <Transcript entries={entries} live={!ended} width={width} />
          <Bottom
            ended={ended}
            asked={asked}
            form={form}
            gate={gate}
            list={list}
            pick={pick}
            copy={copying}
            editor={editor}
            focused={place === "input"}
            selected={selected}
            sessionName={selected.kind === "session" ? (projection.sessionName(selected.id) ?? selected.id) : undefined}
            blocked={state.state === "blocked"}
            note={note}
            width={width}
          />
        </box>
      </box>
      <text fg={ink.dim} style={{ flexShrink: 0 }}>
        {cut(status === "" ? " " : status, size.width)}
      </text>
    </box>
  );
}

function Bottom({
  ended,
  asked,
  form,
  gate,
  list,
  pick,
  copy,
  editor,
  focused,
  selected,
  sessionName,
  blocked,
  note,
  width,
}: {
  ended: boolean;
  asked: Ask | undefined;
  form: Form;
  gate: Extract<Attention, { kind: "gate" }> | undefined;
  list: { list: string[]; many: boolean } | undefined;
  pick: Pick;
  copy: Copying;
  editor: Editor;
  focused: boolean;
  selected: Selection;
  sessionName: string | undefined;
  blocked: boolean;
  note: string;
  width: number;
}): ReactNode {
  if (copy.dirs.length > 0) {
    return <CopyList dirs={copy.dirs} cursor={copy.cursor} width={width} />;
  }
  if (ended) {
    return (
      <box style={{ flexDirection: "column", flexShrink: 0 }}>
        <text fg={ink.faint}>
          {cut(note === "" ? "this run is done. y copies the directory, q goes to the dashboard" : note, width)}
        </text>
      </box>
    );
  }
  if (asked !== undefined) {
    const key = keyOf(asked);
    if (asked.phase === "rejected" && !(form.key === key && form.retype)) {
      const choices = fixes(asked.name);
      return (
        <Choices
          title={`${asked.label} refused the credential. What now?`}
          notes={why(asked)}
          choices={choices.map((one) => ({ label: one.label, ...(one.note === undefined ? {} : { note: one.note }) }))}
          cursor={pick.key === key ? pick.cursor : 0}
          chosen={[]}
          many={false}
          keys="arrows move, enter confirms, esc goes back to typing"
          width={width}
        />
      );
    }
    const state = form.key === key ? form : NO_FORM;
    return (
      <Fields
        title={`${asked.label} needs a credential`}
        notes={notes(asked)}
        fields={asked.fields}
        at={state.at}
        values={state.values}
        buffer={state.buffer}
        width={width}
      />
    );
  }
  if (list !== undefined && gate !== undefined) {
    const key = pickKey(gate, list);
    const mine = pick.key === key;
    const cursor = Math.min(mine ? pick.cursor : 0, list.list.length);
    const keys =
      cursor === list.list.length
        ? "type an answer, enter sends, arrows go back to the options"
        : list.many
          ? "arrows move, space toggles, enter answers, the last row types an answer"
          : "arrows move, enter answers, the last row types an answer";
    return (
      <Choices
        title={brief(gate.question)}
        notes={note === "" ? undefined : [note]}
        choices={list.list.map((label) => ({ label }))}
        cursor={cursor}
        chosen={mine ? pick.chosen : []}
        many={list.many}
        keys={keys}
        editor={editor}
        width={width}
      />
    );
  }
  const prompt =
    gate !== undefined
      ? `answer: ${brief(gate.question)}`
      : selected.kind === "session"
        ? `to ${sessionName ?? selected.id}`
        : "to run";
  const hints: string[] = [];
  if (note !== "") hints.push(note);
  if (!blocked) hints.push("the run is busy: this message queues");
  if (focused) hints.push("enter sends", "esc to the tree", "ctrl-u clears", "ctrl-v pastes an image");
  else hints.push("esc types");
  return <InputBar editor={editor} prompt={`${prompt} >`} hint={fit(hints, width)} focused={focused} width={width} />;
}

function keyOf(one: Attention): string {
  if (one.kind === "gate") return `gate:${one.gate ?? one.question}`;
  return `credential:${one.name}:${one.phase}`;
}

/** The options belong to the key, so a re-ask with other labels starts clean. */
function pickKey(one: Attention, options: { list: string[] }): string {
  return `${keyOf(one)}:${JSON.stringify(options.list)}`;
}

/** The keys that put text in the editor, and so start an answer of their own. */
function inserts(key: KeyEvent): boolean {
  if (key.ctrl && key.name === "v") return true;
  return printable(key) !== undefined;
}

function printable(key: KeyEvent): string | undefined {
  if (key.ctrl || key.meta) return undefined;
  const sequence = key.sequence;
  if (sequence.length !== 1) return undefined;
  const code = sequence.codePointAt(0) ?? 0;
  if (code < 0x20 || code === 0x7f) return undefined;
  return sequence;
}

function endedState(phase: string, alive: boolean): { state: string; detail?: string } {
  if (phase === "live" && !alive) return { state: "done", detail: "the run process died" };
  return { state: phase };
}

function farewell(
  name: string,
  phase: string,
  result: unknown,
  reason: string | undefined,
  alive: boolean,
): Left {
  if (phase === "done") {
    const line = result === undefined ? undefined : typeof result === "string" ? result : JSON.stringify(result);
    return line === undefined ? { back: false, code: 0 } : { back: false, code: 0, note: line };
  }
  if (phase === "stopped") return { back: false, code: 130, note: `run ${name} stopped` };
  if (phase === "error") return { back: false, code: 1, note: `run ${name} failed: ${reason ?? "unknown error"}` };
  if (!alive) return { back: false, code: 1, note: "pn: the run process died" };
  return { back: false, code: 0 };
}

function gitShortstat(cwd: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("git", ["diff", "--shortstat"], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("error", () => resolve(""));
    child.on("close", (code) => resolve(code === 0 ? stdout.trim() : ""));
  });
}

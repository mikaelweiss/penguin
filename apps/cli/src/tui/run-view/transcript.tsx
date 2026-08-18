import type { ViewEvent } from "@mikaelweiss/penguin-engine/protocol";
import type { Entry } from "@mikaelweiss/penguin-viewer";
import { SyntaxStyle } from "@opentui/core";
import type { ReactNode } from "react";
import { cut } from "../text.ts";
import { ink } from "../theme.ts";

let style: SyntaxStyle | undefined;

/** One syntax style for every markdown block penguin draws. */
function markdownStyle(): SyntaxStyle {
  style ??= SyntaxStyle.create();
  return style;
}

export function Transcript({
  entries,
  live,
  width,
}: {
  entries: Entry[];
  live: boolean;
  width: number;
}): ReactNode {
  const last = entries.at(-1)?.seq;
  return (
    <scrollbox
      style={{
        flexGrow: 1,
        flexBasis: 0,
        minHeight: 1,
        rootOptions: { flexGrow: 1, flexBasis: 0, minHeight: 1 },
      }}
      stickyScroll={true}
      stickyStart="bottom"
      scrollY={true}
    >
      {entries.map((entry) => (
        <Line key={entry.seq} event={entry.event} width={width} streaming={live && entry.seq === last} />
      ))}
    </scrollbox>
  );
}

function Line({
  event,
  width,
  streaming,
}: {
  event: ViewEvent;
  width: number;
  streaming: boolean;
}): ReactNode {
  switch (event.type) {
    case "agent":
      if (event.kind === "text") return <Prose text={event.text} width={width} streaming={streaming} />;
      if (event.kind === "thinking") return <text fg={ink.faint}>{indent(event.text)}</text>;
      if (event.kind === "tool") {
        const detail = event.detail === undefined ? "" : ` ${event.detail}`;
        return <text fg={ink.dim}>{cut(`[${event.text}]${detail}`, width)}</text>;
      }
      return <text fg={ink.text}>{event.text.replace(/\n$/, "")}</text>;
    case "gate":
      if (event.phase !== "asked") return <text fg={ink.faint}>{cut(`answered: ${event.answer}`, width)}</text>;
      return (
        <box style={{ flexDirection: "column" }}>
          <text fg={ink.warn}>{cut(`── gate ${"─".repeat(Math.max(0, width - 8))}`, width)}</text>
          <Prose text={event.question} width={width} streaming={false} />
        </box>
      );
    case "message":
      return <text fg={ink.accent}>{`> ${event.text}`}</text>;
    case "event":
      return (
        <text fg={event.level === "info" ? ink.dim : ink.warn}>
          {cut(event.level === "info" ? event.message : `${event.level}: ${event.message}`, width)}
        </text>
      );
    case "artifact": {
      const where = event.path ?? event.url;
      return (
        <text fg={ink.dim}>
          {cut(where === undefined ? `artifact: ${event.title}` : `artifact: ${event.title} (${where})`, width)}
        </text>
      );
    }
    case "credential":
      if (event.phase === "ready") return <text fg={ink.dim}>{`credential ${event.name} ready`}</text>;
      if (event.phase === "rejected") {
        return <text fg={ink.bad}>{cut(`${event.label} refused the credential: ${event.reason}`, width)}</text>;
      }
      return <text fg={ink.warn}>{cut(`${event.label} needs a credential`, width)}</text>;
    case "run":
      if (event.phase === "started") return null;
      if (event.phase === "done") return <text fg={ink.good}>{cut(`run ${event.run} done`, width)}</text>;
      if (event.phase === "stopped") return <text fg={ink.warn}>{`run ${event.run} stopped`}</text>;
      return <text fg={ink.bad}>{cut(`run ${event.run} failed: ${event.reason ?? "unknown error"}`, width)}</text>;
    default:
      return null;
  }
}

function Prose({
  text,
  width,
  streaming,
}: {
  text: string;
  width: number;
  streaming: boolean;
}): ReactNode {
  if (text.trim() === "") return null;
  return (
    <markdown
      content={text}
      syntaxStyle={markdownStyle()}
      streaming={streaming}
      style={{ width, flexShrink: 0 }}
    />
  );
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? "" : `  ${line}`))
    .join("\n");
}

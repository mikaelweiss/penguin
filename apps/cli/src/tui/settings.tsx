import { defaults, installed, writeDefault } from "@mikaelweiss/penguin-engine/catalog";
import type { KeyEvent } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { type ReactNode, useEffect, useState } from "react";
import { Choices } from "./input.tsx";
import { ink } from "./theme.ts";

const PAD = 4;
const CHROME = 6;

/** Centered overlay of agent adapters. Enter writes the default; esc closes. */
export function Settings({ onClose }: { onClose(): void }): ReactNode {
  const size = useTerminalDimensions();
  const [names, setNames] = useState<string[]>([]);
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    let gone = false;
    void installed(process.cwd()).then((found) => {
      if (gone) return;
      const agents = found.filter((entry) => entry.role === "agent").map((entry) => entry.name);
      const chosen = defaults().get("agent");
      const at = agents.indexOf(chosen ?? "");
      setNames(agents);
      setCursor(at < 0 ? 0 : at);
    });
    return () => {
      gone = true;
    };
  }, []);

  useKeyboard((key: KeyEvent) => {
    if (key.eventType === "release") return;
    if (key.ctrl || key.meta) return;
    if (key.name === "escape") return onClose();
    if (names.length === 0) return;
    const last = names.length - 1;
    if (key.name === "up" || key.name === "k" || key.name === "h") {
      return setCursor((at) => (at <= 0 ? last : at - 1));
    }
    if (key.name === "down" || key.name === "j" || key.name === "l") {
      return setCursor((at) => (at >= last ? 0 : at + 1));
    }
    if (key.name === "return" || key.name === "enter") {
      const picked = names[cursor];
      if (picked === undefined) return;
      writeDefault("agent", picked);
      return onClose();
    }
  });

  const width = Math.min(48, Math.max(24, size.width - PAD));
  const height = Math.min(names.length + CHROME, Math.max(CHROME, size.height - PAD));
  const inner = Math.max(10, width - PAD);
  return (
    <box
      style={{
        position: "absolute",
        left: Math.max(0, Math.floor((size.width - width) / 2)),
        top: Math.max(0, Math.floor((size.height - height) / 2)),
        width,
        zIndex: 10,
        border: true,
        borderColor: ink.border,
        backgroundColor: "#1c1c1c",
        padding: 1,
        flexDirection: "column",
      }}
    >
      <Choices
        title="agent adapter"
        choices={names.map((name) => ({ label: name }))}
        cursor={cursor}
        chosen={[]}
        many={false}
        keys="arrows or hjkl move, enter selects, esc closes"
        width={inner}
      />
    </box>
  );
}

import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { type ReactNode, useState } from "react";
import { Dashboard, type Open } from "./dashboard.tsx";
import { type Left, RunView } from "./run-view.tsx";

export type Start = { kind: "dashboard" } | { kind: "run"; name: string; agent: string };

type Screen =
  | { kind: "dashboard" }
  | { kind: "run"; name: string; agent: string; node?: string; ownsExit: boolean };

/** The whole screen: the dashboard, or one run, with q moving between them. */
export function App({ start, onDone }: { start: Start; onDone(left: Left): void }): ReactNode {
  const [screen, setScreen] = useState<Screen>(() =>
    start.kind === "dashboard"
      ? { kind: "dashboard" }
      : { kind: "run", name: start.name, agent: start.agent, ownsExit: true },
  );
  if (screen.kind === "dashboard") {
    const open = (target: Open): void =>
      setScreen({
        kind: "run",
        name: target.name,
        agent: "",
        ...(target.node === undefined ? {} : { node: target.node }),
        ownsExit: false,
      });
    return <Dashboard onOpen={open} onExit={() => onDone({ back: false, code: 0 })} />;
  }
  const leave = (left: Left): void => {
    if (left.back) return setScreen({ kind: "dashboard" });
    onDone(left);
  };
  return (
    <RunView
      key={`${screen.name}:${screen.node ?? ""}`}
      name={screen.name}
      agent={screen.agent}
      {...(screen.node === undefined ? {} : { node: screen.node })}
      ownsExit={screen.ownsExit}
      onLeave={leave}
    />
  );
}

/** Take the terminal, draw until the user leaves, and give it back. */
export async function mount(start: Start): Promise<number> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 });
  const root = createRoot(renderer);
  const left = await new Promise<Left>((resolve) => {
    let settled = false;
    const done = (result: Left): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    root.render(<App start={start} onDone={done} />);
  });
  root.unmount();
  renderer.destroy();
  if (left.note !== undefined) {
    const out = left.note.startsWith("pn:") ? process.stderr : process.stdout;
    out.write(`${left.note}\n`);
  }
  return left.code;
}

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

import { GhosttyTerminalSurface } from "@workspace/terminal/surface";

import { PanelChrome } from "@/components/panel-chrome";
import { useDark } from "@/hooks/use-dark";
import { terminalTheme } from "@/lib/terminal-theme";

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 5000;

type Outbound = { type: "input"; data: string } | { type: "resize"; cols: number; rows: number };

type Wires = {
  socket?: WebSocket;
  surface?: GhosttyTerminalSurface;
  size?: { cols: number; rows: number };
};

/** Keys the app owns even while the terminal is focused. */
function keyIsForTerminal(event: KeyboardEvent): boolean {
  if (event.ctrlKey && !event.metaKey && event.key === "/") return false;
  return !(event.metaKey && (event.key.toLowerCase() === "k" || event.key === ","));
}

export function TerminalPanel({
  runId,
  dir,
  full,
  onToggleFull,
  onClose,
}: {
  runId: string;
  dir: string;
  full: boolean;
  onToggleFull: () => void;
  onClose: () => void;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const wiresRef = useRef<Wires>({});
  const dark = useDark();
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    const mount = mountRef.current;
    if (mount === null) return;
    const wires = wiresRef.current;
    let disposed = false;
    let tries = 0;
    let timer: number | undefined;

    const send = (message: Outbound) => {
      const socket = wires.socket;
      if (socket !== undefined && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
      }
    };

    const retry = (surface: GhosttyTerminalSurface) => {
      const wait = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** tries);
      tries += 1;
      timer = window.setTimeout(() => void connect(surface), wait);
    };

    const connect = async (surface: GhosttyTerminalSurface) => {
      if (disposed) return;
      let port: number;
      try {
        port = await invoke<number>("terminal_host");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        if (!disposed) retry(surface);
        return;
      }
      if (disposed) return;
      const query = new URLSearchParams({ id: runId, cwd: dir });
      if (wires.size !== undefined) {
        query.set("cols", String(wires.size.cols));
        query.set("rows", String(wires.size.rows));
      }
      const socket = new WebSocket(`ws://127.0.0.1:${port}/attach?${query}`);
      wires.socket = socket;
      socket.onopen = () => {
        tries = 0;
        setError(undefined);
        if (wires.size !== undefined) send({ type: "resize", ...wires.size });
      };
      socket.onmessage = (message) => {
        let event: { type?: string; data?: string; snapshot?: { history?: string } };
        try {
          event = JSON.parse(String(message.data)) as typeof event;
        } catch {
          return;
        }
        if (event.type === "output" && typeof event.data === "string") {
          surface.write(event.data);
        } else if (event.type === "snapshot" || event.type === "restarted") {
          surface.resetAndWrite(event.snapshot?.history ?? "");
        } else if (event.type === "exited") {
          surface.write("\r\n[terminal] the shell exited\r\n");
        }
      };
      socket.onclose = () => {
        if (disposed || wires.socket !== socket) return;
        retry(surface);
      };
    };

    const open = async () => {
      const surface = await GhosttyTerminalSurface.create(mount, {
        theme: terminalTheme(),
        onData: (data) => send({ type: "input", data }),
        onResize: (cols, rows) => {
          wires.size = { cols, rows };
          send({ type: "resize", cols, rows });
        },
        onSelectionChange: () => {},
        beforeKey: keyIsForTerminal,
        onLinkActivate: (text) => {
          if (/^https?:\/\//.test(text)) void openUrl(text);
        },
      });
      if (disposed) {
        surface.dispose();
        return;
      }
      wires.surface = surface;
      await connect(surface);
      surface.focus();
    };

    open().catch((cause: unknown) => {
      if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
    });

    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      wires.socket?.close();
      wires.surface?.dispose();
      wiresRef.current = {};
    };
  }, [runId, dir]);

  useEffect(() => {
    wiresRef.current.surface?.setTheme(terminalTheme());
  }, [dark]);

  return (
    <PanelChrome
      name="terminal"
      full={full}
      onToggleFull={onToggleFull}
      onClose={onClose}
      title={
        <>
          <span className="shrink-0">Terminal</span>
          <span className="truncate font-mono">{dir}</span>
          {error !== undefined ? (
            <span className="truncate text-destructive">{error}</span>
          ) : null}
        </>
      }
    >
      <div ref={mountRef} className="relative min-h-0 flex-1 bg-background" />
    </PanelChrome>
  );
}

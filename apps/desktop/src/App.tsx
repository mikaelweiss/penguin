import { useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";

export function App() {
  const [name, setName] = useState("");
  const [greeting, setGreeting] = useState("");

  async function greet(event: FormEvent) {
    event.preventDefault();
    setGreeting(await invoke<string>("greet", { name }));
  }

  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-8 p-6">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">penguin</h1>
          <p className="text-muted-foreground text-sm">
            Run one workflow file as a live process, with any coding agent CLI.
          </p>
        </div>

        <form className="flex flex-col gap-3" onSubmit={greet}>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Enter a name"
          />
          <Button type="submit">Greet</Button>
        </form>

        {greeting ? <p className="text-sm">{greeting}</p> : null}
      </div>

      <p className="text-muted-foreground font-mono text-xs">
        Press <kbd>d</kbd> to toggle dark mode
      </p>
    </main>
  );
}

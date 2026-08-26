import { useEffect, useState } from "react";
import { FolderIcon } from "lucide-react";

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@workspace/ui/components/command";
import { Kbd } from "@workspace/ui/components/kbd";

import { ReadingCatalogs } from "@/components/reading-catalogs";
import type { Startable, WorkflowIndex } from "@/hooks/use-workflow-index";
import { visibleRuns } from "@/lib/runs";
import type { Project, RunNode } from "@/lib/runs";
import type { Workflow } from "@/lib/workflows";

function everyRun(projects: Project[]): RunNode[] {
  return projects.flatMap((project) =>
    visibleRuns(project, { collapsed: new Set(), showFinished: true }),
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <span className="shrink-0 text-xs text-muted-foreground">{children}</span>;
}

const SETTINGS = "open settings";

/** What cmdk matches a workflow row on, and what marks it as the row the cursor starts on. */
function startValue({ workflow }: Startable): string {
  return `start ${workflow.name} ${workflow.description ?? ""} ${workflow.file}`;
}

/** A workflow found in a checkout belongs to one folder, so its row says which. */
function scopeOf({ workflow, projects }: Startable): string {
  if (workflow.scope === "worktree") return `${workflow.worktree} · worktree`;
  const only = projects[0];
  if (workflow.scope !== "project" || only === undefined) return workflow.scope;
  return `${only.name} · project`;
}

type CommandPaletteProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: Project[];
  index: WorkflowIndex;
  onSelectRun: (id: string) => void;
  onStartWorkflow: (workflow: Workflow, dir: string) => void;
  onAppSettings: () => void;
};

export function CommandPalette({
  open,
  onOpenChange,
  projects,
  index,
  onSelectRun,
  onStartWorkflow,
  onAppSettings,
}: CommandPaletteProps) {
  const runs = everyRun(projects);
  const top = index.startable[0];
  const first = top === undefined ? SETTINGS : startValue(top);
  const [cursor, setCursor] = useState(first);
  const [search, setSearch] = useState("");
  /** The workflow whose project is still to be picked. */
  const [picking, setPicking] = useState<Startable | undefined>(undefined);

  // The catalogs land after the dialog opens, so the cursor has to move onto them.
  useEffect(() => {
    setCursor(picking === undefined ? first : (picking.projects[0]?.dir ?? ""));
  }, [first, picking]);

  // What was typed to find the workflow is not what filters its projects.
  useEffect(() => setSearch(""), [picking]);

  const close = () => {
    onOpenChange(false);
    setPicking(undefined);
  };

  const pick = (act: () => void) => {
    close();
    act();
  };

  const choose = (startable: Startable) => {
    const only = startable.projects.length === 1 ? startable.projects[0] : undefined;
    if (only === undefined) {
      setPicking(startable);
      return;
    }
    pick(() => onStartWorkflow(startable.workflow, only.dir));
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
        else onOpenChange(true);
      }}
      title="Command palette"
      description="Search runs, workflows, and settings."
      className="sm:max-w-lg"
    >
      <Command
        value={cursor}
        onValueChange={setCursor}
        onKeyDown={(event) => {
          if (event.key !== "Backspace" || search !== "" || picking === undefined) return;
          event.preventDefault();
          setPicking(undefined);
        }}
      >
        <CommandInput
          value={search}
          onValueChange={setSearch}
          placeholder={
            picking === undefined
              ? "Runs, workflows, settings"
              : `Run ${picking.workflow.name} in`
          }
        />
        <CommandList>
          <CommandEmpty>Nothing matches.</CommandEmpty>
          {picking !== undefined ? (
            <CommandGroup heading={`Run ${picking.workflow.name} in`}>
              {picking.projects.map((project) => (
                <CommandItem
                  key={project.dir}
                  value={project.dir}
                  onSelect={() => pick(() => onStartWorkflow(picking.workflow, project.dir))}
                >
                  <FolderIcon />
                  <span className="shrink-0">{project.name}</span>
                  <Hint>{project.dir}</Hint>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : (
            <>
              {index.reading ? <ReadingCatalogs /> : null}
              <CommandGroup heading="Workflows">
                {index.startable.map((startable) => (
                  <CommandItem
                    key={startable.workflow.file}
                    value={startValue(startable)}
                    onSelect={() => choose(startable)}
                    className="items-start"
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate">{startable.workflow.name}</span>
                      {startable.workflow.description === undefined ? null : (
                        <span className="truncate text-xs text-muted-foreground">
                          {startable.workflow.description}
                        </span>
                      )}
                    </div>
                    <Hint>{scopeOf(startable)}</Hint>
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandGroup heading="Settings">
                <CommandItem value={SETTINGS} onSelect={() => pick(onAppSettings)}>
                  <span className="min-w-0 flex-1 truncate">Open settings</span>
                  <Kbd>⌘,</Kbd>
                </CommandItem>
              </CommandGroup>
              <CommandGroup heading="Runs">
                {runs.map(({ run, project }) => (
                  <CommandItem
                    key={run.id}
                    value={`${run.name} ${project.name} ${run.id}`}
                    onSelect={() => pick(() => onSelectRun(run.id))}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {run.name} · {project.name}
                    </span>
                    <Hint>{run.ask ? "needs you" : run.status}</Hint>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}

import { useEffect, useRef, useState } from "react";
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
import { ranked } from "@/lib/ranking";
import type { Band } from "@/lib/ranking";
import { visibleRuns } from "@/lib/runs";
import type { Project, RunNode } from "@/lib/runs";
import type { Workflow } from "@/lib/workflows";

/** One command row: what a search ranks it on, and the item the list renders for it. */
type Row = { value: string; item: React.ReactElement };

function everyRun(projects: Project[]): RunNode[] {
  return projects.flatMap((project) =>
    visibleRuns(project, { collapsed: new Set(), showFinished: true }),
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <span className="shrink-0 text-xs text-muted-foreground">{children}</span>;
}

const SETTINGS = "open settings";

/** What a search matches a workflow row on. */
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
  const [cursor, setCursor] = useState("");
  const [search, setSearch] = useState("");
  /** The workflow whose project is still to be picked. */
  const [picking, setPicking] = useState<Startable | undefined>(undefined);
  const list = useRef<HTMLDivElement>(null);

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

  const bands: Band<Row>[] =
    picking === undefined
      ? [
          {
            title: "Workflows",
            rows: index.startable.map((startable) => {
              const value = startValue(startable);
              return {
                value,
                item: (
                  <CommandItem
                    key={startable.workflow.file}
                    value={value}
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
                ),
              };
            }),
          },
          {
            title: "Settings",
            rows: [
              {
                value: SETTINGS,
                item: (
                  <CommandItem key={SETTINGS} value={SETTINGS} onSelect={() => pick(onAppSettings)}>
                    <span className="min-w-0 flex-1 truncate">Open settings</span>
                    <Kbd>⌘,</Kbd>
                  </CommandItem>
                ),
              },
            ],
          },
          {
            title: "Runs",
            rows: runs.map(({ run, project }) => {
              const value = `${run.name} ${project.name} ${run.id}`;
              return {
                value,
                item: (
                  <CommandItem
                    key={run.id}
                    value={value}
                    onSelect={() => pick(() => onSelectRun(run.id))}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {run.name} · {project.name}
                    </span>
                    <Hint>{run.ask ? "needs you" : run.status}</Hint>
                  </CommandItem>
                ),
              };
            }),
          },
        ]
      : [
          {
            title: `Run ${picking.workflow.name} in`,
            rows: picking.projects.map((project) => ({
              value: project.dir,
              item: (
                <CommandItem
                  key={project.dir}
                  value={project.dir}
                  onSelect={() => pick(() => onStartWorkflow(picking.workflow, project.dir))}
                >
                  <FolderIcon />
                  <span className="shrink-0">{project.name}</span>
                  <Hint>{project.dir}</Hint>
                </CommandItem>
              ),
            })),
          },
        ];

  const found = ranked(bands, search);

  // The catalogs land after the dialog opens and a search reorders what landed, so the cursor
  // follows the best match instead of sitting where the last render left it.
  useEffect(() => setCursor(found.top ?? ""), [search, found.top]);

  useEffect(() => list.current?.scrollTo({ top: 0 }), [search]);

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
        shouldFilter={false}
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
        <CommandList ref={list}>
          <CommandEmpty>Nothing matches.</CommandEmpty>
          {picking === undefined && index.reading ? <ReadingCatalogs /> : null}
          {found.bands.map((band) => (
            <CommandGroup key={band.title} heading={band.title}>
              {band.rows.map((row) => row.item)}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}

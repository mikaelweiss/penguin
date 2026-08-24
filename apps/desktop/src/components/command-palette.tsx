import { useEffect, useState } from "react";

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
import { Spinner } from "@workspace/ui/components/spinner";

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
function startValue({ workflow, project }: Startable): string {
  return `start ${workflow.name} ${project.name} ${project.dir} ${workflow.description ?? ""}`;
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

  // The catalogs land after the dialog opens, so the cursor has to move onto them.
  useEffect(() => setCursor(first), [first]);

  const pick = (act: () => void) => {
    onOpenChange(false);
    act();
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Command palette"
      description="Search runs, workflows, and settings."
      className="sm:max-w-lg"
    >
      <Command value={cursor} onValueChange={setCursor}>
        <CommandInput placeholder="Runs, workflows, settings" />
        <CommandList>
          <CommandEmpty>Nothing matches.</CommandEmpty>
          {index.reading ? (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Spinner />
              Reading the catalogs
            </div>
          ) : null}
          <CommandGroup heading="Workflows">
            {index.startable.map((startable) => (
              <CommandItem
                key={`${startable.project.dir}:${startable.workflow.file}`}
                value={startValue(startable)}
                onSelect={() =>
                  pick(() => onStartWorkflow(startable.workflow, startable.project.dir))
                }
              >
                <span className="min-w-0 flex-1 truncate">
                  Start {startable.workflow.name} · {startable.project.name}
                </span>
                <Hint>{startable.workflow.scope}</Hint>
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading="Settings">
            <CommandItem value={SETTINGS} onSelect={() => pick(onAppSettings)}>
              <span className="min-w-0 flex-1 truncate">Open settings</span>
              <Kbd>⇧⌘,</Kbd>
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
        </CommandList>
      </Command>
    </CommandDialog>
  );
}

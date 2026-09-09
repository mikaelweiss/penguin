import { useCallback, useEffect, useId, useRef, useState } from "react";
import { TriangleAlertIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@workspace/ui/components/alert";
import { Button } from "@workspace/ui/components/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@workspace/ui/components/command";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@workspace/ui/components/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select";
import { Spinner } from "@workspace/ui/components/spinner";
import { cn } from "@workspace/ui/lib/utils";

import { ReadingCatalogs } from "@/components/reading-catalogs";
import { WorkflowParams } from "@/components/workflow-params";
import type { Config } from "@/hooks/use-config";
import { useParamAttachments } from "@/hooks/use-param-attachments";
import { fill, initialValues, paramsOf, withAttachments } from "@/lib/params";
import type { Values } from "@/lib/params";
import {
  AGENT,
  agentsIn,
  claimRun,
  describe,
  discardRun,
  shelves,
  startRun,
} from "@/lib/workflows";
import type { Adapter, Workflow } from "@/lib/workflows";

type Trouble = { title: string; detail: string };

function detailOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

type NewWorkflowDialogProps = {
  /** The project directory the run starts in. The dialog is open whenever there is one. */
  dir: string | undefined;
  /** The workflow the palette already picked, so the search step is skipped. */
  preset: Workflow | undefined;
  /** The shared config, for the agent adapter a run starts with unless the picker says otherwise. */
  config: Config;
  onClose: () => void;
  onStarted: (id: string) => void;
};

type AgentPickerProps = {
  agents: Adapter[];
  reading: boolean;
  value: string;
  onChange: (name: string) => void;
};

/** Which agent adapter this run defaults to. A session naming another adapter still gets it. */
function AgentPicker({ agents, reading, value, onChange }: AgentPickerProps) {
  const id = useId();
  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor={id}>Agent</FieldLabel>
        <FieldDescription>
          {!reading && agents.length === 0
            ? "No agent adapter is installed."
            : "The agent adapter this run starts with."}
        </FieldDescription>
      </FieldContent>
      <Select value={value} disabled={reading || agents.length === 0} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-40">
          <SelectValue placeholder="Not chosen" />
        </SelectTrigger>
        <SelectContent>
          {agents.map((adapter) => (
            <SelectItem key={adapter.file} value={adapter.name}>
              {adapter.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

export function NewWorkflowDialog({
  dir,
  preset,
  config,
  onClose,
  onStarted,
}: NewWorkflowDialogProps) {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [agents, setAgents] = useState<Adapter[]>([]);
  const [reading, setReading] = useState(false);
  const [trouble, setTrouble] = useState<Trouble | undefined>(undefined);
  const [picked, setPicked] = useState<Workflow | undefined>(undefined);
  const [values, setValues] = useState<Values>({});
  const [agent, setAgent] = useState("");
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [starting, setStarting] = useState(false);
  const claimed = useRef<Promise<string> | undefined>(undefined);
  /** What a dismissed dialog left to the start still in flight, holding the claim it had. */
  const parked = useRef<{ held: Promise<string> | undefined } | undefined>(undefined);

  /** One folder per dialog, claimed on the first paste. A claim that fails lets the next try. */
  const claim = useCallback(() => {
    claimed.current ??= claimRun().catch((cause: unknown) => {
      claimed.current = undefined;
      throw cause;
    });
    return claimed.current;
  }, []);
  const attach = useParamAttachments(claim);

  useEffect(() => {
    if (dir === undefined) return;
    setWorkflows([]);
    setAgents([]);
    setReading(true);
    describe(dir).then(
      (catalogs) => {
        setWorkflows(catalogs.workflows);
        setAgents(agentsIn(catalogs.adapters));
        const first = catalogs.errors[0];
        setTrouble(first === undefined ? undefined : { title: "Cannot read the catalogs", detail: first });
        setReading(false);
      },
      (cause: unknown) => {
        setTrouble({ title: "Cannot read the catalogs", detail: detailOf(cause) });
        setReading(false);
      },
    );
  }, [dir]);

  const drop = (held: Promise<string> | undefined) => {
    if (held !== undefined) held.then(discardRun).catch(() => undefined);
  };

  const close = () => {
    const held = claimed.current;
    claimed.current = undefined;
    // A start in flight owns its folder until it settles, so leaving parks the claim for it.
    if (starting) parked.current = { held };
    else drop(held);
    onClose();
    setPicked(undefined);
    setProblems({});
    setTrouble(undefined);
    attach.reset();
  };

  const start = (workflow: Workflow, params: Record<string, unknown>) => {
    if (dir === undefined) return;
    setStarting(true);
    const folder = claimed.current?.catch(() => undefined) ?? Promise.resolve(undefined);
    folder
      .then((id) => startRun(workflow.file, params, dir, id, agent === "" ? undefined : agent))
      .then(
        (id) => {
          parked.current = undefined;
          setStarting(false);
          claimed.current = undefined;
          close();
          onStarted(id);
        },
        (cause: unknown) => {
          setStarting(false);
          const left = parked.current;
          parked.current = undefined;
          // Nobody is left to ask again, so the folder the start never used goes now.
          if (left !== undefined) {
            drop(left.held);
            return;
          }
          setTrouble({ title: `Cannot start ${workflow.name}`, detail: detailOf(cause) });
        },
      );
  };

  // Every start passes through the form, params or none, so the agent picker is always in reach.
  const choose = (workflow: Workflow) => {
    setValues(initialValues(paramsOf(workflow.params)));
    setAgent(config.values[AGENT] ?? "");
    setProblems({});
    setTrouble(undefined);
    attach.reset();
    setPicked(workflow);
  };

  useEffect(() => {
    if (dir === undefined || preset === undefined) return;
    choose(preset);
  }, [dir, preset]);

  const submit = () => {
    if (picked === undefined) return;
    const params = paramsOf(picked.params);
    const filled = fill(params, withAttachments(params, values, attach.files));
    if ("problems" in filled) {
      setProblems(filled.problems);
      return;
    }
    setProblems({});
    start(picked, filled.params);
  };

  const problem =
    trouble ??
    (attach.error === undefined
      ? undefined
      : { title: "Cannot attach the file", detail: attach.error });

  const alert = problem ? (
    <Alert variant="destructive">
      <TriangleAlertIcon />
      <AlertTitle>{problem.title}</AlertTitle>
      <AlertDescription>{problem.detail}</AlertDescription>
    </Alert>
  ) : null;

  return (
    <Dialog
      open={dir !== undefined}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        className={cn(
          "sm:max-w-xl",
          picked === undefined &&
            preset === undefined &&
            "gap-0 p-0 [&>[data-slot=command]]:min-h-0",
        )}
      >
        {picked !== undefined ? (
          <>
            <DialogHeader>
              <DialogTitle>{picked.name}</DialogTitle>
              <DialogDescription>{picked.description}</DialogDescription>
            </DialogHeader>
            <DialogBody>
              <FieldGroup>
                {paramsOf(picked.params).length === 0 ? null : (
                  <WorkflowParams
                    params={paramsOf(picked.params)}
                    values={values}
                    problems={problems}
                    attachments={attach.files}
                    onChange={(name, value) =>
                      setValues((current) => ({ ...current, [name]: value }))
                    }
                    onPaste={attach.paste}
                    onRemove={attach.remove}
                  />
                )}
                <AgentPicker agents={agents} reading={reading} value={agent} onChange={setAgent} />
              </FieldGroup>
            </DialogBody>
            {alert}
            <DialogFooter>
              <Button
                variant="ghost"
                onClick={preset === undefined ? () => setPicked(undefined) : close}
                disabled={starting}
              >
                {preset === undefined ? "Back" : "Cancel"}
              </Button>
              <Button onClick={submit} disabled={starting}>
                {starting ? <Spinner data-icon="inline-start" /> : null}
                {starting ? "Starting" : "Start"}
              </Button>
            </DialogFooter>
          </>
        ) : preset !== undefined ? (
          <>
            <DialogHeader>
              <DialogTitle>{preset.name}</DialogTitle>
              <DialogDescription>{preset.description}</DialogDescription>
            </DialogHeader>
            {alert ?? <Spinner />}
          </>
        ) : (
          <>
            <DialogHeader className="sr-only">
              <DialogTitle>New workflow</DialogTitle>
              <DialogDescription>Search the catalogs and pick a workflow to run.</DialogDescription>
            </DialogHeader>
            <Command>
              <CommandInput placeholder="Search workflows" />
              <CommandList>
                {reading ? (
                  <ReadingCatalogs />
                ) : (
                  <CommandEmpty>No workflow matches.</CommandEmpty>
                )}
                {shelves(workflows).map((shelf) => (
                  <CommandGroup key={shelf.scope} heading={shelf.title}>
                    {shelf.workflows.map((workflow) => (
                      <CommandItem
                        key={workflow.file}
                        value={`${workflow.scope} ${workflow.worktree ?? ""} ${workflow.name} ${
                          workflow.description ?? ""
                        }`}
                        disabled={workflow.error !== undefined}
                        onSelect={() => choose(workflow)}
                        className="flex-col items-start gap-0.5"
                      >
                        <div className="flex items-baseline gap-2 text-sm">
                          {workflow.name}
                          {workflow.worktree === undefined ? null : (
                            <span className="text-xs text-muted-foreground">
                              {workflow.worktree}
                            </span>
                          )}
                        </div>
                        <div
                          className={cn(
                            "text-xs",
                            workflow.error === undefined
                              ? "text-muted-foreground"
                              : "text-destructive",
                          )}
                        >
                          {workflow.error ?? workflow.description}
                        </div>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ))}
              </CommandList>
            </Command>
            {problem ? <div className="border-t p-3">{alert}</div> : null}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

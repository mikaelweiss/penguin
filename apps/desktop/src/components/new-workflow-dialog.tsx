import { useCallback, useEffect, useRef, useState } from "react";
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
import { Spinner } from "@workspace/ui/components/spinner";
import { cn } from "@workspace/ui/lib/utils";

import { ReadingCatalogs } from "@/components/reading-catalogs";
import { WorkflowParams } from "@/components/workflow-params";
import { useParamAttachments } from "@/hooks/use-param-attachments";
import { fill, initialValues, paramsOf, withAttachments } from "@/lib/params";
import type { Values } from "@/lib/params";
import { claimRun, describe, discardRun, shelves, startRun } from "@/lib/workflows";
import type { Workflow } from "@/lib/workflows";

type Trouble = { title: string; detail: string };

function detailOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

type NewWorkflowDialogProps = {
  /** The project directory the run starts in. The dialog is open whenever there is one. */
  dir: string | undefined;
  /** The workflow the palette already picked, so the search step is skipped. */
  preset: Workflow | undefined;
  onClose: () => void;
  onStarted: (id: string) => void;
};

export function NewWorkflowDialog({ dir, preset, onClose, onStarted }: NewWorkflowDialogProps) {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [reading, setReading] = useState(false);
  const [trouble, setTrouble] = useState<Trouble | undefined>(undefined);
  const [picked, setPicked] = useState<Workflow | undefined>(undefined);
  const [values, setValues] = useState<Values>({});
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [starting, setStarting] = useState(false);
  const claimed = useRef<Promise<string> | undefined>(undefined);

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
    if (dir === undefined || preset !== undefined) return;
    setWorkflows([]);
    setReading(true);
    describe(dir).then(
      (catalogs) => {
        setWorkflows(catalogs.workflows);
        const first = catalogs.errors[0];
        setTrouble(first === undefined ? undefined : { title: "Cannot read the catalogs", detail: first });
        setReading(false);
      },
      (cause: unknown) => {
        setTrouble({ title: "Cannot read the catalogs", detail: detailOf(cause) });
        setReading(false);
      },
    );
  }, [dir, preset]);

  const close = () => {
    const held = claimed.current;
    claimed.current = undefined;
    if (held !== undefined) held.then(discardRun).catch(() => undefined);
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
      .then((id) => startRun(workflow.file, params, dir, id))
      .then(
        (id) => {
          setStarting(false);
          claimed.current = undefined;
          close();
          onStarted(id);
        },
        (cause: unknown) => {
          setStarting(false);
          setTrouble({ title: `Cannot start ${workflow.name}`, detail: detailOf(cause) });
        },
      );
  };

  const choose = (workflow: Workflow) => {
    const params = paramsOf(workflow.params);
    if (params.length === 0) {
      start(workflow, {});
      return;
    }
    setValues(initialValues(params));
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
              <WorkflowParams
                params={paramsOf(picked.params)}
                values={values}
                problems={problems}
                attachments={attach.files}
                onChange={(name, value) => setValues((current) => ({ ...current, [name]: value }))}
                onPaste={attach.paste}
                onRemove={attach.remove}
              />
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
            {alert ?? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner />
                Starting {preset.name}
              </div>
            )}
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
                        value={`${workflow.scope} ${workflow.name} ${workflow.description ?? ""}`}
                        disabled={workflow.error !== undefined}
                        onSelect={() => choose(workflow)}
                        className="flex-col items-start gap-0.5"
                      >
                        <div className="text-sm">{workflow.name}</div>
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

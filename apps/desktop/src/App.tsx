import { useState } from "react";
import { TriangleAlertIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@workspace/ui/components/alert";
import { Separator } from "@workspace/ui/components/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@workspace/ui/components/sidebar";
import { TooltipProvider } from "@workspace/ui/components/tooltip";

import { RunActivity } from "@/components/run-activity";
import { RunBreadcrumb } from "@/components/run-breadcrumb";
import { RunComposer } from "@/components/run-composer";
import { RunSidebar } from "@/components/run-sidebar";
import { RunTranscript } from "@/components/run-transcript";
import { useInbox } from "@/hooks/use-inbox";
import { useRuns } from "@/hooks/use-runs";
import { findRun } from "@/lib/runs";

export function App() {
  const { projects, error } = useRuns();
  const inbox = useInbox();
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const selected = findRun(projects, selectedId);
  const run = selected?.run;

  return (
    <TooltipProvider>
      <SidebarProvider className="isolate h-svh">
        <RunSidebar projects={projects} selectedId={selectedId} onSelect={setSelectedId} />
        <SidebarInset className="min-w-0 overflow-hidden">
          <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
            <SidebarTrigger />
            <Separator orientation="vertical" className="h-4 data-vertical:self-center" />
            {selected ? (
              <RunBreadcrumb node={selected} onSelect={setSelectedId} />
            ) : (
              <div className="text-sm text-muted-foreground">No run selected</div>
            )}
            {selected ? (
              <div className="hidden min-w-0 truncate font-mono text-xs text-muted-foreground md:block">
                {selected.run.dir}
              </div>
            ) : null}
          </header>
          {error ? (
            <Alert variant="destructive" className="m-4 w-auto">
              <TriangleAlertIcon />
              <AlertTitle>Cannot read the run files</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : (
            <>
              <RunTranscript run={run} sent={run === undefined ? [] : (inbox.sent[run.id] ?? [])} />
              {run ? <RunActivity run={run} /> : null}
              {run !== undefined && (run.ask !== undefined || run.listening) ? (
                <RunComposer
                  key={`${run.id}:${run.ask?.prompt ?? ""}`}
                  run={run}
                  error={inbox.error}
                  onSend={(entry) => inbox.send(run.id, entry)}
                />
              ) : null}
            </>
          )}
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}

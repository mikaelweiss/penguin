import { useState } from "react";

import { Separator } from "@workspace/ui/components/separator";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@workspace/ui/components/sidebar";
import { TooltipProvider } from "@workspace/ui/components/tooltip";

import { RunBreadcrumb } from "@/components/run-breadcrumb";
import { RunSidebar } from "@/components/run-sidebar";
import { RunTranscript } from "@/components/run-transcript";
import { findRun } from "@/lib/runs";
import { sampleProjects } from "@/lib/sample-runs";

export function App() {
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const selected = findRun(sampleProjects, selectedId);

  return (
    <TooltipProvider>
      <SidebarProvider className="isolate h-svh">
        <RunSidebar
          projects={sampleProjects}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
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
          <RunTranscript run={selected?.run} />
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}

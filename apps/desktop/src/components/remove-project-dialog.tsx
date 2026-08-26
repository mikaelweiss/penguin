import { FolderMinusIcon } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@workspace/ui/components/alert-dialog";

import { subtree } from "@/lib/runs";
import type { Project } from "@/lib/runs";

type RemoveProjectDialogProps = {
  /** The project the confirmation settles. The dialog is open whenever there is one. */
  project: Project | undefined;
  onCancel: () => void;
  onHide: () => void;
  onDelete: () => void;
};

function counted(runs: number): string {
  return runs === 1 ? "1 run" : `${runs} runs`;
}

/** Taking a project off the sidebar either keeps its runs on disk or deletes them. */
export function RemoveProjectDialog({
  project,
  onCancel,
  onHide,
  onDelete,
}: RemoveProjectDialogProps) {
  const runs = project === undefined ? 0 : project.runs.flatMap(subtree).length;

  return (
    <AlertDialog
      open={project !== undefined}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia>
            <FolderMinusIcon />
          </AlertDialogMedia>
          <AlertDialogTitle>Remove {project?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {runs === 0
              ? "The project leaves the sidebar. The folder on disk stays."
              : `The project holds ${counted(runs)}. Hide them to keep them on disk, or delete them for good. Either way the folder on disk stays, and a new run here brings the project back.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          {runs === 0 ? (
            <AlertDialogAction onClick={onHide}>Remove</AlertDialogAction>
          ) : (
            <>
              <AlertDialogAction variant="outline" onClick={onHide}>
                Hide runs
              </AlertDialogAction>
              <AlertDialogAction variant="destructive" onClick={onDelete}>
                Delete runs
              </AlertDialogAction>
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

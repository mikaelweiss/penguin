import { useEffect, useId, useState } from "react";

import { Button } from "@workspace/ui/components/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog";
import { Field, FieldLabel } from "@workspace/ui/components/field";
import { Input } from "@workspace/ui/components/input";

import type { Run } from "@/lib/runs";

type RenameRunDialogProps = {
  /** The run being renamed. The dialog is open whenever there is one. */
  run: Run | undefined;
  onClose: () => void;
  onRename: (run: Run, name: string) => void;
};

export function RenameRunDialog({ run, onClose, onRename }: RenameRunDialogProps) {
  const [name, setName] = useState("");
  const id = useId();

  useEffect(() => {
    if (run !== undefined) setName(run.name);
  }, [run]);

  const submit = (event: React.SyntheticEvent) => {
    event.preventDefault();
    if (run === undefined || name.trim() === "") return;
    onRename(run, name.trim());
    onClose();
  };

  return (
    <Dialog
      open={run !== undefined}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <form onSubmit={submit} className="contents">
          <DialogHeader>
            <DialogTitle>Rename run</DialogTitle>
            <DialogDescription>
              The name shows in the sidebar. The run keeps going.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <Field>
              <FieldLabel htmlFor={id}>Name</FieldLabel>
              <Input
                id={id}
                value={name}
                autoFocus
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={name.trim() === ""}>
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

import { Trash2Icon } from "lucide-react";

import { Button } from "@workspace/ui/components/button";
import { Field, FieldContent, FieldDescription, FieldTitle } from "@workspace/ui/components/field";
import { Spinner } from "@workspace/ui/components/spinner";

import { DefinitionList, SettingsPane, SettingsShell } from "@/components/settings-shell";
import type { Definition } from "@/components/settings-shell";
import { useCatalogs } from "@/hooks/use-catalogs";
import type { Project } from "@/lib/runs";

const SECTIONS = [
  { value: "settings", label: "Settings" },
  { value: "workflows", label: "Workflows" },
  { value: "skills", label: "Skills" },
  { value: "adapters", label: "Adapters" },
];

type ProjectSettingsDialogProps = {
  /** The project the modal settles. The modal is open whenever there is one. */
  project: Project | undefined;
  onClose: () => void;
  onRemove: (dir: string) => void;
};

/** What one project holds: its directory, and the workflows, skills, and adapters it can reach. */
export function ProjectSettingsDialog({
  project,
  onClose,
  onRemove,
}: ProjectSettingsDialogProps) {
  const { catalogs, reading, error } = useCatalogs(project?.dir);

  const workflows: Definition[] = catalogs.workflows.map((workflow) => ({
    key: workflow.file,
    name: workflow.name,
    detail: workflow.error ?? workflow.description,
    scope: workflow.scope,
  }));
  const skills: Definition[] = catalogs.skills.map((skill) => ({
    key: skill.dir,
    name: skill.name,
    detail: skill.description,
    scope: skill.scope,
  }));
  const adapters: Definition[] = catalogs.adapters.map((adapter) => ({
    key: adapter.file,
    name: adapter.name,
    note: adapter.role,
    detail: adapter.description,
    scope: adapter.scope,
  }));

  const listing = (items: Definition[], empty: string) =>
    reading ? (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Spinner />
        Reading the catalogs
      </div>
    ) : (
      <DefinitionList items={items} empty={empty} />
    );

  return (
    <SettingsShell
      open={project !== undefined}
      onClose={onClose}
      title={project === undefined ? "Project settings" : `${project.name} settings`}
      description="What this project holds, and where it lives."
      lead={
        <p className="truncate px-2.5 pt-1 font-mono text-xs text-muted-foreground">
          {project?.dir}
        </p>
      }
      sections={SECTIONS}
    >
      <SettingsPane value="settings" heading="Settings">
        <Field orientation="horizontal">
          <FieldContent>
            <FieldTitle>Directory</FieldTitle>
            <FieldDescription className="font-mono">{project?.dir}</FieldDescription>
          </FieldContent>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={() => {
              if (project !== undefined) onRemove(project.dir);
              onClose();
            }}
          >
            <Trash2Icon data-icon="inline-start" />
            Remove
          </Button>
        </Field>
      </SettingsPane>

      <SettingsPane value="workflows" heading="Workflows" trouble={error}>
        {listing(workflows, "No workflow is in reach of this project.")}
      </SettingsPane>

      <SettingsPane value="skills" heading="Skills" trouble={error}>
        {listing(skills, "No skill is in reach of this project.")}
      </SettingsPane>

      <SettingsPane value="adapters" heading="Adapters" trouble={error}>
        {listing(adapters, "No adapter is in reach of this project.")}
      </SettingsPane>
    </SettingsShell>
  );
}

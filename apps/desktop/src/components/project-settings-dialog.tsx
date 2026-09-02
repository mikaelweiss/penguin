import { ListChecksIcon, Trash2Icon } from "lucide-react";

import { Button } from "@workspace/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@workspace/ui/components/empty";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from "@workspace/ui/components/field";
import { Textarea } from "@workspace/ui/components/textarea";

import { ReadingCatalogs } from "@/components/reading-catalogs";
import { DefinitionList, SettingsPane, SettingsShell } from "@/components/settings-shell";
import type { Definition } from "@/components/settings-shell";
import { useCatalogs } from "@/hooks/use-catalogs";
import { useGates } from "@/hooks/use-gates";
import { troubles } from "@/lib/gates";
import type { Project } from "@/lib/runs";

const SECTIONS = [
  { value: "settings", label: "Settings" },
  { value: "gates", label: "Gates" },
  { value: "workflows", label: "Workflows" },
  { value: "skills", label: "Skills" },
  { value: "adapters", label: "Adapters" },
];

const GATES_EXAMPLE = `# what a change has to pass
bun run check
[apps/desktop] nx run desktop:typecheck`;

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
  const gates = useGates(project?.dir);

  const workflows: Definition[] = catalogs.workflows.map((workflow) => ({
    key: workflow.file,
    name: workflow.name,
    detail: workflow.error ?? workflow.description,
    scope: workflow.worktree ?? workflow.scope,
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
      <ReadingCatalogs />
    ) : (
      <DefinitionList items={items} empty={empty} />
    );

  const gateTrouble = troubles(gates.draft ?? "").map((trouble) => ({
    message: `Line ${trouble.line}: ${trouble.detail}`,
  }));

  return (
    <SettingsShell
      open={project !== undefined}
      onClose={onClose}
      title={project === undefined ? "Project settings" : `${project.name} settings`}
      description="What this project holds, and where it lives."
      lead={
        <p className="truncate px-2 pb-2 font-mono text-xs text-muted-foreground">
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

      <SettingsPane value="gates" heading="Gates" trouble={gates.error}>
        {gates.reading ? <ReadingCatalogs label="Reading the gates" /> : null}
        {!gates.reading && gates.draft === undefined ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ListChecksIcon />
              </EmptyMedia>
              <EmptyTitle>No gates yet</EmptyTitle>
              <EmptyDescription>
                An agent drafts .penguin/gates on the first run. Write it yourself to say now
                what a change has to pass.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="outline" size="sm" onClick={gates.start}>
                Write the gates
              </Button>
            </EmptyContent>
          </Empty>
        ) : null}
        {gates.draft === undefined ? null : (
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="gates">.penguin/gates</FieldLabel>
              <FieldDescription>
                One shell command a line, run in order. A line opening with # is a comment, and
                [path] in front of a command runs it only for a change under that path.
              </FieldDescription>
              <Textarea
                id="gates"
                value={gates.draft}
                placeholder={GATES_EXAMPLE}
                spellCheck={false}
                className="min-h-64 font-mono"
                onChange={(event) => gates.edit(event.target.value)}
              />
              <FieldError errors={gateTrouble} />
            </Field>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldDescription>
                  The gate file sits in the project root, and every run reads it from there.
                </FieldDescription>
              </FieldContent>
              <Button
                size="sm"
                disabled={!gates.dirty || gates.saving}
                onClick={gates.save}
              >
                Save
              </Button>
            </Field>
          </FieldGroup>
        )}
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

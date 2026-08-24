import { useEffect, useState } from "react";
import { homeDir } from "@tauri-apps/api/path";
import { FolderIcon, FolderPlusIcon, Trash2Icon } from "lucide-react";

import { Button } from "@workspace/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@workspace/ui/components/empty";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@workspace/ui/components/field";
import { Input } from "@workspace/ui/components/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@workspace/ui/components/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select";
import { Switch } from "@workspace/ui/components/switch";

import { SettingsPane, SettingsShell } from "@/components/settings-shell";
import { useTheme } from "@/components/theme-provider";
import { useCatalogs } from "@/hooks/use-catalogs";
import type { Config } from "@/hooks/use-config";
import { useDark } from "@/hooks/use-dark";
import type { Directories } from "@/hooks/use-directories";

const SECTIONS = [
  { value: "general", label: "General" },
  { value: "directories", label: "Directories" },
];

const WORKTREES_DEFAULT = "~/.penguin/worktrees/<project>/<run>";

/** The role the engine reads a run's coding agent from. */
const AGENT = "agent";

function useHome(open: boolean): string | undefined {
  const [dir, setDir] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!open || dir !== undefined) return;
    void homeDir().then(setDir);
  }, [open, dir]);
  return dir;
}

type AppSettingsDialogProps = {
  open: boolean;
  onClose: () => void;
  config: Config;
  directories: Directories;
};

/** The settings every project shares: the theme, the default agent, and where worktrees go. */
export function AppSettingsDialog({ open, onClose, config, directories }: AppSettingsDialogProps) {
  const { setTheme } = useTheme();
  const dark = useDark();
  const home = useHome(open);
  const { catalogs, error } = useCatalogs(open ? home : undefined);
  const [worktrees, setWorktrees] = useState<string | undefined>(undefined);

  const agents = catalogs.adapters.filter((adapter) => adapter.role === AGENT);
  const saved = config.values["worktrees"] ?? "";
  const typed = worktrees ?? saved;

  const commitWorktrees = () => {
    setWorktrees(undefined);
    if (typed !== saved) config.set("worktrees", typed);
  };

  return (
    <SettingsShell
      open={open}
      onClose={onClose}
      title="Settings"
      description="The settings every project shares."
      sections={SECTIONS}
    >
      <SettingsPane value="general" heading="General" trouble={config.error ?? error}>
        <FieldGroup>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="dark-mode">Dark mode</FieldLabel>
              <FieldDescription>The whole app, both ways. Press d to flip it.</FieldDescription>
            </FieldContent>
            <Switch
              id="dark-mode"
              checked={dark}
              onCheckedChange={(next) => setTheme(next ? "dark" : "light")}
            />
          </Field>

          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="default-agent">Default agent</FieldLabel>
              <FieldDescription>
                {agents.length === 0
                  ? "No agent adapter is installed."
                  : "The agent adapter a new run uses."}
              </FieldDescription>
            </FieldContent>
            <Select
              value={config.values[AGENT] ?? ""}
              disabled={agents.length === 0}
              onValueChange={(next) => config.set(AGENT, next)}
            >
              <SelectTrigger id="default-agent" className="w-40">
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

          <Field>
            <FieldLabel htmlFor="worktrees">Worktrees</FieldLabel>
            <FieldDescription>Where a run that opens a worktree puts it.</FieldDescription>
            <Input
              id="worktrees"
              value={typed}
              placeholder={WORKTREES_DEFAULT}
              onChange={(event) => setWorktrees(event.target.value)}
              onBlur={commitWorktrees}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
              className="font-mono"
            />
          </Field>
        </FieldGroup>
      </SettingsPane>

      <SettingsPane value="directories" heading="Directories" trouble={directories.error}>
        {directories.dirs.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FolderIcon />
              </EmptyMedia>
              <EmptyTitle>No directories</EmptyTitle>
              <EmptyDescription>Add a project to start a workflow in it.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ItemGroup className="gap-0">
            {directories.dirs.map((dir) => (
              <Item key={dir} size="sm" className="px-0">
                <ItemMedia variant="icon">
                  <FolderIcon />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle className="font-mono">{dir}</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${dir}`}
                    onClick={() => directories.remove(dir)}
                  >
                    <Trash2Icon />
                  </Button>
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        )}
        <div className="mt-4">
          <Button variant="outline" size="sm" onClick={directories.add}>
            <FolderPlusIcon data-icon="inline-start" />
            Add a directory
          </Button>
        </div>
      </SettingsPane>
    </SettingsShell>
  );
}

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { GitStatusEntry } from "@pierre/trees";
import { FolderTreeIcon, SearchIcon, XIcon } from "lucide-react";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@workspace/ui/components/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@workspace/ui/components/input-group";
import { ScrollArea } from "@workspace/ui/components/scroll-area";

import { FileTabContent } from "@/components/file-tab-content";
import { FileTree } from "@/components/file-tree";
import { PanelSidebarHandle } from "@/components/panel-sidebar-handle";
import { applyFileListKeyDown, ReviewFileList } from "@/components/review-file-list";
import { useFileTree } from "@/hooks/use-file-tree";
import { fileNameOf } from "@/lib/file-path";
import { searchFiles, type FileChange, type FileStatus, type ReviewRoot } from "@/lib/files";
import { statusEntries } from "@/lib/review-kinds";

const RESULTS = 200;
/** How long typing has to settle before the project is searched again. */
const SETTLE = 120;

export type FileBrowserTabProps = {
  root: ReviewRoot | undefined;
  /** True when no file is picked yet, so the pane shows the placeholder. */
  placeholder: boolean;
  /** The tab whose file fills the pane, when placeholder is false. */
  tab: string;
  /** The path highlighted in the tree. */
  active: string | undefined;
  /** Changed files, so the tree can badge them. */
  changes: readonly FileChange[];
  sidebarOpen: boolean;
  sidebarWidth: number;
  onSidebarWidth: (width: number) => void;
  /** Single click: preview. */
  onSelect: (path: string) => void;
  /** Double click or Enter: pin. */
  onSelectPermanent: (path: string) => void;
  /** So the plus button can focus the filter. */
  filterRef: (element: HTMLInputElement | null) => void;
};

function baseName(root: string): string {
  return fileNameOf(root.replace(/\\/g, "/").replace(/\/+$/, "")) || root;
}

function useDebounced(value: string, delay: number): string {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    if (value === "") {
      setSettled("");
      return;
    }
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return settled;
}

function Note({ children }: { children: string }) {
  return (
    <p role="status" className="px-2 py-2 text-xs text-muted-foreground">
      {children}
    </p>
  );
}

/** The file browser: a lazy tree of the whole project, a search over it, and the opened file. */
export function FileBrowserTab(props: FileBrowserTabProps) {
  const root = props.root?.root;
  const tree = useFileTree(root);
  const results = useId();

  const [filter, setFilter] = useState("");
  const [found, setFound] = useState<readonly string[]>([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<string | undefined>(undefined);
  // A query and its hits belong to the project that answered them, and no other.
  const scope = useRef(root);
  if (scope.current !== root) {
    scope.current = root;
    setFilter("");
    setFound([]);
    setPicked(undefined);
  }

  const query = filter.trim();
  const settled = useDebounced(query, SETTLE);

  useEffect(() => {
    if (root === undefined || settled === "") {
      setFound([]);
      setSearching(false);
      return;
    }
    let live = true;
    setSearching(true);
    searchFiles(root, settled, RESULTS)
      .then((paths) => {
        if (!live) return;
        setFound([...new Set(paths)]);
        setSearching(false);
      })
      .catch(() => {
        if (!live) return;
        setFound([]);
        setSearching(false);
      });
    return () => {
      live = false;
    };
  }, [root, settled]);

  const status = useMemo<GitStatusEntry[]>(() => {
    const byPath = new Map<string, GitStatusEntry>();
    for (const entry of tree.ignored) byPath.set(entry.path, entry);
    for (const entry of statusEntries(props.changes)) byPath.set(entry.path, entry);
    return [...byPath.values()];
  }, [tree.ignored, props.changes]);

  const kinds = useMemo<ReadonlyMap<string, FileStatus>>(
    () => new Map(props.changes.map((change) => [change.file, change.status])),
    [props.changes],
  );

  const highlighted = useMemo(() => {
    if (found.length === 0) return undefined;
    if (picked !== undefined && found.includes(picked)) return picked;
    return found[0];
  }, [found, picked]);

  const optionId = (path: string) => `${results}-option-${found.indexOf(path)}`;

  const onFilterKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && query !== "") {
      event.preventDefault();
      setFilter("");
      return;
    }
    if (query === "") return;
    applyFileListKeyDown(event.nativeEvent, found, highlighted, {
      onHighlight: setPicked,
      onSelect: props.onSelectPermanent,
    });
  };

  const open = props.placeholder || props.sidebarOpen;
  const title = root === undefined ? "Files" : baseName(root);

  const browse = () => {
    if (tree.paths.length === 0) {
      if (tree.error !== undefined) return <Note>{tree.error}</Note>;
      if (!tree.loaded.has("")) return <Note>Reading the files.</Note>;
      return <Note>No files.</Note>;
    }
    return (
      <div className="flex h-full min-h-0 flex-col">
        {tree.error === undefined ? null : <Note>{tree.error}</Note>}
        <div className="min-h-0 flex-1">
          <FileTree
            paths={tree.paths}
            status={status}
            active={props.active}
            onSelect={props.onSelect}
            onSelectPermanent={props.onSelectPermanent}
            onExpand={tree.list}
            className="h-full w-full"
          />
        </div>
      </div>
    );
  };

  const search = () => {
    if (searching && found.length === 0) return <Note>Searching.</Note>;
    if (found.length === 0) return <Note>No matches.</Note>;
    return (
      <ScrollArea className="h-full">
        <ReviewFileList
          id={results}
          role="listbox"
          optionId={optionId}
          files={found}
          status={kinds}
          active={props.active}
          highlighted={highlighted}
          onFileClick={(path) => {
            setPicked(path);
            props.onSelect(path);
          }}
          onFileDoubleClick={props.onSelectPermanent}
        />
      </ScrollArea>
    );
  };

  return (
    <div className="flex min-h-0 flex-1">
      {open ? (
        <aside
          className="relative flex min-h-0 shrink-0 flex-col border-r"
          style={{ width: `${props.sidebarWidth}px` }}
        >
          <div className="flex h-9 shrink-0 items-center border-b px-3">
            <span className="truncate text-xs font-medium">{title}</span>
          </div>
          <div className="shrink-0 p-2">
            <InputGroup>
              <InputGroupAddon>
                <SearchIcon className="size-4" />
              </InputGroupAddon>
              <InputGroupInput
                ref={props.filterRef}
                value={filter}
                autoFocus={props.placeholder}
                placeholder="Filter files"
                aria-label="Filter files"
                role="combobox"
                aria-autocomplete="list"
                aria-controls={results}
                aria-activedescendant={highlighted === undefined ? undefined : optionId(highlighted)}
                aria-expanded={query.length > 0 && found.length > 0}
                onChange={(event) => setFilter(event.currentTarget.value)}
                onKeyDown={onFilterKeyDown}
              />
              {filter.length > 0 ? (
                <InputGroupAddon align="inline-end">
                  <InputGroupButton
                    size="icon-xs"
                    aria-label="Clear the filter"
                    onClick={() => setFilter("")}
                  >
                    <XIcon />
                  </InputGroupButton>
                </InputGroupAddon>
              ) : null}
            </InputGroup>
          </div>
          <div className="min-h-0 flex-1">{query === "" ? browse() : search()}</div>
          <PanelSidebarHandle width={props.sidebarWidth} onWidth={props.onSidebarWidth} />
        </aside>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col">
        {props.placeholder ? (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FolderTreeIcon />
              </EmptyMedia>
              <EmptyTitle>Open file</EmptyTitle>
              <EmptyDescription>Select a file to open.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <FileTabContent root={props.root} tab={props.tab} />
        )}
      </div>
    </div>
  );
}

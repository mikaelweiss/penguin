import { useEffect, useMemo } from "react";
import type { CodeViewItem } from "@pierre/diffs";

import { DiffCodeView } from "@/components/diff-code-view";
import { useDark } from "@/hooks/use-dark";
import { useFileContent } from "@/hooks/use-file-content";
import { pathFromTab } from "@/lib/file-path";
import { diffCacheKey, diffTheme } from "@/lib/diff";
import type { ReviewRoot } from "@/lib/files";

export type FileTabContentProps = { root: ReviewRoot | undefined; tab: string };

function Note({ children }: { children: string }) {
  return <p className="px-3 py-2 text-xs text-muted-foreground">{children}</p>;
}

/** One opened file, re-read whenever the watcher names it. */
export function FileTabContent(props: FileTabContentProps) {
  const dark = useDark();
  const path = pathFromTab(props.tab);
  const files = useFileContent(props.root?.root);
  const { load, setOpen } = files;

  useEffect(() => {
    if (path === undefined || path === "") return;
    setOpen([path]);
    load(path);
  }, [path, load, setOpen]);

  const state = path === undefined ? undefined : files.get(path);
  const content = state?.content;

  const items = useMemo<CodeViewItem[]>(() => {
    if (path === undefined || content?.kind !== "text") return [];
    return [
      {
        id: path,
        type: "file",
        file: { name: path, contents: content.text, cacheKey: diffCacheKey(content.text) },
      },
    ];
  }, [path, content]);

  if (path === undefined) return <Note>That tab holds no file.</Note>;
  if (state?.error !== undefined) return <Note>{state.error}</Note>;
  if (content === undefined) return <Note>Reading the file.</Note>;
  if (content.kind === "missing") return <Note>This file is gone.</Note>;
  if (content.kind === "binary") return <Note>This file is binary.</Note>;
  if (content.kind === "large") return <Note>This file is too large to show.</Note>;

  return (
    <DiffCodeView
      key={path}
      items={items}
      className="min-h-0 flex-1 overflow-auto"
      options={{
        theme: diffTheme(dark),
        overflow: "scroll",
        enableLineSelection: false,
        enableGutterUtility: false,
      }}
    />
  );
}

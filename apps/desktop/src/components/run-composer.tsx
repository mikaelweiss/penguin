import { useEffect, useId, useRef, useState } from "react";
import { CornerDownLeftIcon } from "lucide-react";
import { menuOfSchema } from "@mikaelweiss/penguin-engine/view";

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupText,
  InputGroupTextarea,
} from "@workspace/ui/components/input-group";
import { Kbd } from "@workspace/ui/components/kbd";
import { cn } from "@workspace/ui/lib/utils";

import { AttachmentRow } from "@/components/attachment-row";
import { useAttachments } from "@/hooks/use-attachments";
import { useFileDrop } from "@/hooks/use-file-drop";
import { bodyOf } from "@/lib/attachments";
import type { Attachment } from "@/lib/attachments";
import type { InboxEntry } from "@/lib/inbox";
import type { Run } from "@/lib/runs";

/** Where the cursor sits when it has left the choices for the text field. */
const TEXT = -1;

function atStart(field: HTMLTextAreaElement): boolean {
  return field.selectionStart === 0 && field.selectionEnd === 0;
}

type RunComposerProps = {
  run: Run;
  onSend: (entry: InboxEntry, files: Attachment[]) => void;
  error: string | undefined;
};

export function RunComposer({ run, onSend, error }: RunComposerProps) {
  const menu = run.ask?.schema === undefined ? undefined : menuOfSchema(run.ask.schema);
  const typing = menu === undefined || menu.other;
  const [cursor, setCursor] = useState(menu === undefined ? TEXT : 0);
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());
  const [text, setText] = useState("");
  const choices = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const group = useRef<HTMLDivElement>(null);
  const listId = useId();
  const attach = useAttachments(run.id);
  const hovering = useFileDrop(group, attach.drop);

  useEffect(() => {
    if (choices.current !== null) choices.current.focus();
    else field.current?.focus();
  }, []);

  /** A menu choice is the whole answer, so attachments ride only a typed payload. */
  const carries = menu === undefined || cursor === TEXT;
  const problem = attach.error ?? error;

  const toggle = (index: number) =>
    setPicked((current) => {
      const next = new Set(current);
      if (!next.delete(index)) next.add(index);
      return next;
    });

  function answer(): unknown {
    if (menu === undefined || carries) {
      const body = bodyOf(attach.files, text);
      return body === "" ? undefined : body;
    }
    if (menu.many) {
      return menu.choices.filter((_, index) => picked.has(index)).map((choice) => choice.value);
    }
    return menu.choices[cursor]?.value;
  }

  function send(entry: InboxEntry): void {
    onSend(entry, carries ? attach.files : []);
    if (carries) attach.clear();
    setText("");
  }

  function submit(): void {
    if (run.ask === undefined) {
      const message = bodyOf(attach.files, text);
      if (message === "") return;
      send({ message });
      return;
    }
    const value = answer();
    if (value === undefined) return;
    send({ answer: value });
  }

  function onPaste(event: React.ClipboardEvent): void {
    const pasted = Array.from(event.clipboardData.files);
    if (pasted.length === 0) return;
    event.preventDefault();
    attach.paste(pasted);
  }

  function onChoiceKeys(event: React.KeyboardEvent): void {
    if (menu === undefined) return;
    if (event.key === "ArrowDown" || event.key === "j") {
      event.preventDefault();
      if (cursor < menu.choices.length - 1) setCursor(cursor + 1);
      else if (typing) field.current?.focus();
    } else if (event.key === "ArrowUp" || event.key === "k") {
      event.preventDefault();
      if (cursor > 0) setCursor(cursor - 1);
    } else if (event.key === " " && menu.many) {
      event.preventDefault();
      toggle(cursor);
    } else if (event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  }

  function onFieldKeys(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    } else if (event.key === "ArrowUp" && menu !== undefined && atStart(event.currentTarget)) {
      event.preventDefault();
      setCursor(menu.choices.length - 1);
      choices.current?.focus();
    }
  }

  return (
    <div className="shrink-0 border-t p-3">
      <InputGroup
        ref={group}
        onPaste={onPaste}
        className={cn(hovering && "border-ring ring-3 ring-ring/50")}
      >
        {run.ask ? (
          <InputGroupAddon
            align="block-start"
            className="flex-col items-stretch gap-1.5 border-b cursor-default select-text"
          >
            <InputGroupText className="items-start font-mono text-[0.8125rem]/6 text-warning">
              <span aria-hidden="true" className="w-3 shrink-0">
                ?
              </span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap">{run.ask.prompt}</span>
            </InputGroupText>

            {menu ? (
              <div
                ref={choices}
                role="listbox"
                data-slot="input-group-control"
                tabIndex={0}
                aria-label="answers"
                aria-multiselectable={menu.many}
                aria-activedescendant={cursor === TEXT ? undefined : `${listId}-${cursor}`}
                onKeyDown={onChoiceKeys}
                onFocus={() => setCursor((current) => (current === TEXT ? 0 : current))}
                className="flex flex-col outline-none"
              >
                {menu.choices.map((choice, index) => (
                  <div
                    key={index}
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={menu.many ? picked.has(index) : index === cursor}
                    onClick={() => {
                      setCursor(index);
                      if (menu.many) toggle(index);
                    }}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 font-mono text-[0.8125rem]/6",
                      (menu.many ? picked.has(index) : index === cursor)
                        ? "text-foreground"
                        : "text-muted-foreground",
                    )}
                  >
                    <span aria-hidden="true" className="w-3 shrink-0 select-none">
                      {index === cursor ? ">" : ""}
                    </span>
                    {menu.many ? (
                      <span aria-hidden="true" className="select-none">
                        {picked.has(index) ? "[x]" : "[ ]"}
                      </span>
                    ) : null}
                    <span className="min-w-0 truncate">{choice.label}</span>
                  </div>
                ))}
              </div>
            ) : null}

            {run.ask.problem ? (
              <InputGroupText className="items-start font-mono text-[0.8125rem]/6 text-destructive">
                {run.ask.problem}
              </InputGroupText>
            ) : null}
          </InputGroupAddon>
        ) : null}

        {attach.files.length > 0 ? (
          <InputGroupAddon align="block-start" className="border-b">
            <AttachmentRow files={attach.files} onRemove={attach.remove} className="w-full" />
          </InputGroupAddon>
        ) : null}

        {typing ? (
          <InputGroupTextarea
            ref={field}
            value={text}
            rows={1}
            placeholder={
              run.ask === undefined
                ? "Message the run"
                : menu === undefined
                  ? "Type an answer"
                  : "or type an answer"
            }
            onChange={(event) => setText(event.target.value)}
            onFocus={() => setCursor(TEXT)}
            onKeyDown={onFieldKeys}
            className="max-h-40 font-mono text-[0.8125rem]/6"
          />
        ) : null}

        <InputGroupAddon align="block-end" className="border-t">
          <InputGroupText className={cn("text-xs", problem !== undefined && "text-destructive")}>
            {problem ?? (menu ? "arrows move, enter sends" : "enter sends, shift enter adds a line")}
          </InputGroupText>
          <InputGroupButton variant="default" className="ml-auto" onClick={submit}>
            {run.ask ? "Answer" : "Send"}
            <Kbd className="bg-transparent text-primary-foreground">
              <CornerDownLeftIcon />
            </Kbd>
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}

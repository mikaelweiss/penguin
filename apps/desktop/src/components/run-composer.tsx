import { useEffect, useId, useRef, useState } from "react";
import { CornerDownLeftIcon } from "lucide-react";
import { menuOfSchema } from "@mikaelweiss/penguin-engine/view";

import { Checkbox } from "@workspace/ui/components/checkbox";
import { Field, FieldGroup, FieldLabel } from "@workspace/ui/components/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupText,
  InputGroupTextarea,
} from "@workspace/ui/components/input-group";
import { Kbd } from "@workspace/ui/components/kbd";
import { RadioGroup, RadioGroupItem } from "@workspace/ui/components/radio-group";
import { cn } from "@workspace/ui/lib/utils";

import { AttachmentRow } from "@/components/attachment-row";
import { useAttachments } from "@/hooks/use-attachments";
import { useFileDrop } from "@/hooks/use-file-drop";
import { bodyOf } from "@/lib/attachments";
import type { Attachment } from "@/lib/attachments";
import type { InboxEntry } from "@/lib/inbox";
import type { Run } from "@/lib/runs";

const CHOICE = "[role=radio], [role=checkbox]";

type RunComposerProps = {
  run: Run;
  onSend: (entry: InboxEntry, files: Attachment[]) => void;
  error: string | undefined;
};

export function RunComposer({ run, onSend, error }: RunComposerProps) {
  const menu = run.ask?.schema === undefined ? undefined : menuOfSchema(run.ask.schema);
  const typing = menu === undefined || menu.other;
  const [chosen, setChosen] = useState("0");
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());
  const [text, setText] = useState("");
  const choices = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const group = useRef<HTMLDivElement>(null);
  const listId = useId();
  const attach = useAttachments(run.id);
  const hovering = useFileDrop(group, attach.drop);

  useEffect(() => {
    const first = choices.current?.querySelector<HTMLElement>(CHOICE);
    if (first !== null && first !== undefined) first.focus();
    else field.current?.focus();
  }, []);

  const body = bodyOf(attach.files, text);
  /** A menu choice is the whole answer, so attachments ride only a typed payload. */
  const carries = menu === undefined || (typing && body !== "");
  const problem = attach.error ?? error;

  const toggle = (index: number) =>
    setPicked((current) => {
      const next = new Set(current);
      if (!next.delete(index)) next.add(index);
      return next;
    });

  function answer(): unknown {
    if (menu === undefined || carries) return body === "" ? undefined : body;
    if (menu.many) {
      return menu.choices.filter((_, index) => picked.has(index)).map((choice) => choice.value);
    }
    return menu.choices[Number(chosen)]?.value;
  }

  function send(entry: InboxEntry): void {
    onSend(entry, carries ? attach.files : []);
    if (carries) attach.clear();
    setText("");
  }

  function submit(): void {
    if (run.ask === undefined) {
      if (body === "") return;
      send({ message: body });
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

  function step(rows: HTMLElement[], from: number, by: number): void {
    const next = from + by;
    if (next >= rows.length) {
      if (typing) field.current?.focus();
      return;
    }
    if (next < 0) return;
    rows[next]?.focus();
    if (menu !== undefined && !menu.many) setChosen(String(next));
  }

  /** Enter answers from the choices, j and k walk them, and running off the end reaches the text field. */
  function onChoiceKeys(event: React.KeyboardEvent): void {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
      return;
    }
    const rows = Array.from(choices.current?.querySelectorAll<HTMLElement>(CHOICE) ?? []);
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
    if (plain && (event.key === "j" || event.key === "k")) {
      event.preventDefault();
      step(rows, at, event.key === "j" ? 1 : -1);
      return;
    }
    if (!typing || (event.key !== "ArrowDown" && event.key !== "Tab")) return;
    if (event.shiftKey || at !== rows.length - 1) return;
    event.preventDefault();
    field.current?.focus();
  }

  function onFieldKeys(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
      return;
    }
    const atStart = event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === 0;
    if (event.key !== "ArrowUp" || menu === undefined || !atStart) return;
    event.preventDefault();
    const rows = choices.current?.querySelectorAll<HTMLElement>(CHOICE);
    rows?.[rows.length - 1]?.focus();
  }

  const rows =
    menu === undefined
      ? null
      : menu.choices.map((choice, index) => (
          <Field key={index} orientation="horizontal">
            {menu.many ? (
              <Checkbox
                id={`${listId}-${index}`}
                checked={picked.has(index)}
                onCheckedChange={() => toggle(index)}
              />
            ) : (
              <RadioGroupItem id={`${listId}-${index}`} value={String(index)} />
            )}
            <FieldLabel htmlFor={`${listId}-${index}`} className="font-normal">
              {choice.label}
            </FieldLabel>
          </Field>
        ));

  return (
    <div className="shrink-0 border-t p-3">
      <InputGroup
        ref={group}
        onPaste={onPaste}
        className={cn(hovering && "border-ring ring-3 ring-ring/50")}
      >
        {menu === undefined && run.ask?.problem === undefined ? null : (
          <InputGroupAddon
            align="block-start"
            className="flex-col items-stretch gap-2.5 border-b cursor-default select-text"
          >
            {menu === undefined ? null : menu.many ? (
              <FieldGroup ref={choices} onKeyDown={onChoiceKeys} className="gap-2">
                {rows}
              </FieldGroup>
            ) : (
              <RadioGroup
                ref={choices}
                value={chosen}
                onValueChange={setChosen}
                onKeyDown={onChoiceKeys}
                aria-label="answers"
                loop={false}
                className="gap-2"
              >
                {rows}
              </RadioGroup>
            )}

            {run.ask?.problem ? (
              <InputGroupText className="items-start font-mono text-destructive">
                {run.ask.problem}
              </InputGroupText>
            ) : null}
          </InputGroupAddon>
        )}

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
            onKeyDown={onFieldKeys}
            className="max-h-40 font-mono"
          />
        ) : null}

        <InputGroupAddon align="block-end" className="border-t">
          <InputGroupText className={cn("text-xs", problem !== undefined && "text-destructive")}>
            {problem ?? (menu ? "j k or arrows move, enter sends" : "enter sends, shift enter adds a line")}
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

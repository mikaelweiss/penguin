import { useId } from "react";

import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@workspace/ui/components/field";
import { Input } from "@workspace/ui/components/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select";
import { Switch } from "@workspace/ui/components/switch";
import { Textarea } from "@workspace/ui/components/textarea";

import { AttachmentRow } from "@/components/attachment-row";
import type { Attachment } from "@/lib/attachments";
import { canAttach } from "@/lib/params";
import type { Control, Param, Values } from "@/lib/params";

type ControlProps = {
  id: string;
  control: Control;
  value: string;
  invalid: boolean;
  onChange: (value: string) => void;
  onPaste: ((files: File[]) => void) | undefined;
};

function pasted(onPaste: ((files: File[]) => void) | undefined) {
  if (onPaste === undefined) return undefined;
  return (event: React.ClipboardEvent) => {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    event.preventDefault();
    onPaste(files);
  };
}

function ParamControl({ id, control, value, invalid, onChange, onPaste }: ControlProps) {
  if (control.kind === "choice") {
    return (
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} aria-invalid={invalid}>
          <SelectValue placeholder="Pick one" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {control.choices.map((choice) => (
              <SelectItem key={choice} value={choice}>
                {choice}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    );
  }

  if (control.kind === "lines" || control.kind === "json") {
    return (
      <Textarea
        id={id}
        rows={3}
        value={value}
        aria-invalid={invalid}
        placeholder={control.kind === "lines" ? "one per line" : "JSON"}
        className={control.kind === "json" ? "font-mono" : undefined}
        onChange={(event) => onChange(event.target.value)}
        onPaste={pasted(onPaste)}
      />
    );
  }

  return (
    <Input
      id={id}
      type={control.kind === "number" ? "number" : "text"}
      value={value}
      aria-invalid={invalid}
      onChange={(event) => onChange(event.target.value)}
      onPaste={pasted(onPaste)}
    />
  );
}

type ParamRowProps = {
  param: Param;
  value: string | boolean;
  problem: string | undefined;
  files: Attachment[];
  onChange: (name: string, value: string | boolean) => void;
  onPaste: (name: string, files: File[]) => void;
  onRemove: (name: string, file: Attachment) => void;
};

function ParamRow({ param, value, problem, files, onChange, onPaste, onRemove }: ParamRowProps) {
  const id = useId();
  const invalid = problem !== undefined;

  if (param.control.kind === "boolean") {
    return (
      <Field orientation="horizontal" data-invalid={invalid}>
        <FieldContent>
          <FieldLabel htmlFor={id}>{param.name}</FieldLabel>
          {param.description ? <FieldDescription>{param.description}</FieldDescription> : null}
        </FieldContent>
        <Switch
          id={id}
          checked={value === true}
          onCheckedChange={(next) => onChange(param.name, next)}
        />
      </Field>
    );
  }

  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={id}>{param.name}</FieldLabel>
      <ParamControl
        id={id}
        control={param.control}
        value={typeof value === "string" ? value : ""}
        invalid={invalid}
        onChange={(next) => onChange(param.name, next)}
        onPaste={canAttach(param.control) ? (files) => onPaste(param.name, files) : undefined}
      />
      <AttachmentRow files={files} onRemove={(file) => onRemove(param.name, file)} />
      {param.description ? <FieldDescription>{param.description}</FieldDescription> : null}
      <FieldError>{problem}</FieldError>
    </Field>
  );
}

type WorkflowParamsProps = {
  params: Param[];
  values: Values;
  problems: Record<string, string>;
  attachments: Record<string, Attachment[]>;
  onChange: (name: string, value: string | boolean) => void;
  onPaste: (name: string, files: File[]) => void;
  onRemove: (name: string, file: Attachment) => void;
};

/** The form a workflow's params schema asks for, one row per property. */
export function WorkflowParams({
  params,
  values,
  problems,
  attachments,
  onChange,
  onPaste,
  onRemove,
}: WorkflowParamsProps) {
  return (
    <FieldGroup>
      {params.map((param) => (
        <ParamRow
          key={param.name}
          param={param}
          value={values[param.name] ?? ""}
          problem={problems[param.name]}
          files={attachments[param.name] ?? []}
          onChange={onChange}
          onPaste={onPaste}
          onRemove={onRemove}
        />
      ))}
    </FieldGroup>
  );
}

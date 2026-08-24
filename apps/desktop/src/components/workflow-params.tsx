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

import type { Control, Param, Values } from "@/lib/params";

type ControlProps = {
  id: string;
  control: Control;
  value: string;
  invalid: boolean;
  onChange: (value: string) => void;
};

function ParamControl({ id, control, value, invalid, onChange }: ControlProps) {
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
    />
  );
}

type ParamRowProps = {
  param: Param;
  value: string | boolean;
  problem: string | undefined;
  onChange: (name: string, value: string | boolean) => void;
};

function ParamRow({ param, value, problem, onChange }: ParamRowProps) {
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
      />
      {param.description ? <FieldDescription>{param.description}</FieldDescription> : null}
      <FieldError>{problem}</FieldError>
    </Field>
  );
}

type WorkflowParamsProps = {
  params: Param[];
  values: Values;
  problems: Record<string, string>;
  onChange: (name: string, value: string | boolean) => void;
};

/** The form a workflow's params schema asks for, one row per property. */
export function WorkflowParams({ params, values, problems, onChange }: WorkflowParamsProps) {
  return (
    <FieldGroup>
      {params.map((param) => (
        <ParamRow
          key={param.name}
          param={param}
          value={values[param.name] ?? ""}
          problem={problems[param.name]}
          onChange={onChange}
        />
      ))}
    </FieldGroup>
  );
}

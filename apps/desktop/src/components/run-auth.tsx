import { useId, useState } from "react";
import { KeyRoundIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@workspace/ui/components/alert";
import { Button } from "@workspace/ui/components/button";
import { Field, FieldGroup, FieldLabel } from "@workspace/ui/components/field";
import { Input } from "@workspace/ui/components/input";

import { storeAuthSecret } from "@/lib/auth";
import type { Auth } from "@/lib/runs";

type RunAuthProps = {
  auth: Auth;
};

/**
 * The run paused for credentials. The adapter's note names the fields; saving puts them in
 * the keychain and bumps the epoch file, so every paused run retries and clears its own note.
 */
export function RunAuth({ auth }: RunAuthProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const id = useId();

  const typed = (name: string): string => (values[name] ?? "").trim();
  const ready = auth.fields.length > 0 && auth.fields.every((field) => typed(field.name) !== "");

  async function save(event: React.SyntheticEvent): Promise<void> {
    event.preventDefault();
    if (!ready || saving) return;
    setSaving(true);
    setProblem(undefined);
    try {
      await storeAuthSecret(
        auth.role,
        Object.fromEntries(auth.fields.map((field) => [field.name, typed(field.name)])),
      );
      setValues((held) =>
        Object.fromEntries(
          Object.entries(held).filter(
            ([name]) => !auth.fields.some((field) => field.name === name && field.secret === true),
          ),
        ),
      );
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : String(cause));
      setSaving(false);
    }
  }

  return (
    <div className="shrink-0 border-t p-3">
      <form onSubmit={save} className="flex flex-col gap-3">
        <Alert>
          <KeyRoundIcon />
          <AlertTitle>The run is waiting on {auth.role} credentials</AlertTitle>
          <AlertDescription>{problem ?? auth.reason}</AlertDescription>
        </Alert>

        <FieldGroup className="gap-3 sm:flex-row">
          {auth.fields.map((field) => (
            <Field key={field.name}>
              <FieldLabel htmlFor={`${id}-${field.name}`}>{field.label}</FieldLabel>
              <Input
                id={`${id}-${field.name}`}
                type={field.secret === true ? "password" : "text"}
                value={values[field.name] ?? ""}
                placeholder={field.placeholder}
                autoComplete="off"
                onChange={(event) =>
                  setValues((held) => ({ ...held, [field.name]: event.target.value }))
                }
              />
            </Field>
          ))}
        </FieldGroup>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={!ready || saving}>
            {saving ? "Waiting for the run" : "Save and continue"}
          </Button>
          {auth.help !== undefined ? (
            <a
              href={auth.help.url}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-muted-foreground underline underline-offset-4"
            >
              {auth.help.label}
            </a>
          ) : null}
        </div>
      </form>
    </div>
  );
}

import { useId, useState } from "react";
import { KeyRoundIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@workspace/ui/components/alert";
import { Button } from "@workspace/ui/components/button";
import { Field, FieldGroup, FieldLabel } from "@workspace/ui/components/field";
import { Input } from "@workspace/ui/components/input";

import { storeAuthSecret } from "@/lib/auth";
import type { Auth } from "@/lib/runs";

const TOKENS = "https://id.atlassian.com/manage-profile/security/api-tokens";

type RunAuthProps = {
  auth: Auth;
};

/**
 * The run paused for credentials. Saving puts them in the keychain and bumps
 * the epoch file, so every paused run retries and clears its own note.
 */
export function RunAuth({ auth }: RunAuthProps) {
  const [site, setSite] = useState("");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const id = useId();

  const ready = site.trim() !== "" && email.trim() !== "" && token.trim() !== "";

  async function save(event: React.SyntheticEvent): Promise<void> {
    event.preventDefault();
    if (!ready || saving) return;
    setSaving(true);
    setProblem(undefined);
    try {
      await storeAuthSecret(auth.role, {
        site: site.trim(),
        email: email.trim(),
        token: token.trim(),
      });
      setToken("");
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
          <Field>
            <FieldLabel htmlFor={`${id}-site`}>Site</FieldLabel>
            <Input
              id={`${id}-site`}
              value={site}
              placeholder="your-team.atlassian.net"
              autoComplete="off"
              onChange={(event) => setSite(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-email`}>Email</FieldLabel>
            <Input
              id={`${id}-email`}
              type="email"
              value={email}
              placeholder="you@example.com"
              autoComplete="off"
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-token`}>API token</FieldLabel>
            <Input
              id={`${id}-token`}
              type="password"
              value={token}
              autoComplete="off"
              onChange={(event) => setToken(event.target.value)}
            />
          </Field>
        </FieldGroup>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={!ready || saving}>
            {saving ? "Waiting for the run" : "Save and continue"}
          </Button>
          <a
            href={TOKENS}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-muted-foreground underline underline-offset-4"
          >
            Make an API token
          </a>
        </div>
      </form>
    </div>
  );
}

export class WaError extends Error {}

export class Parked extends Error {
  fatal: boolean;

  constructor(reason: string, fatal: boolean) {
    super(reason);
    this.fatal = fatal;
  }
}

export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

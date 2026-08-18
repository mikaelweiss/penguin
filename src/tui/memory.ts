import os from "node:os";
import { runCommand } from "../spawn.ts";

const GB = 1024 ** 3;
const PAGES = /^Pages (free|inactive|speculative|purgeable):\s+(\d+)/;
const PAGE_SIZE = /page size of (\d+) bytes/;

export type Machine = { used: number; total: number; load: number; cores: number };

/**
 * What the machine has left. `os.freemem` counts only unused pages, so on darwin it reads
 * near full on a healthy machine. `vm_stat` counts the pages the kernel can hand out.
 */
export async function machine(): Promise<Machine> {
  const total = os.totalmem();
  const free = os.platform() === "darwin" ? await available(total) : os.freemem();
  return {
    used: Math.max(0, total - Math.min(free, total)),
    total,
    load: os.loadavg()[0] ?? 0,
    cores: os.cpus().length,
  };
}

/** The readout the dashboard prints, for example `ram 20/32 GB  load 8.5/10`. */
export function machineLine(one: Machine): string {
  const ram = `ram ${round(one.used)}/${round(one.total)} GB`;
  return `${ram}  load ${one.load.toFixed(1)}/${one.cores}`;
}

/** True when another run would oversubscribe the machine, which is what the readout warns about. */
export function strained(one: Machine): boolean {
  return one.load >= one.cores || one.used > one.total * 0.9;
}

async function available(total: number): Promise<number> {
  const done = await runCommand("vm_stat", os.tmpdir()).catch(() => undefined);
  if (done === undefined || done.code !== 0) return os.freemem();
  const size = Number(PAGE_SIZE.exec(done.stdout)?.[1] ?? 0);
  if (size === 0) return os.freemem();
  let pages = 0;
  let read = false;
  for (const line of done.stdout.split("\n")) {
    const found = PAGES.exec(line);
    if (found === null) continue;
    pages += Number(found[2]);
    read = true;
  }
  return read ? Math.min(pages * size, total) : os.freemem();
}

function round(bytes: number): string {
  return String(Math.round(bytes / GB));
}

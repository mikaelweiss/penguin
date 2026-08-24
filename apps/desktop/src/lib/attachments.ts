import { invoke } from "@tauri-apps/api/core";

export type Attachment = {
  path: string;
  name: string;
  /** An object URL for the preview, only for an image. */
  thumbnail: string | undefined;
};

const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "heic"]);

export function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function isImage(name: string): boolean {
  return IMAGES.has(name.slice(name.lastIndexOf(".") + 1).toLowerCase());
}

/** A clipboard image arrives without a name of its own. */
function nameFor(file: File): string {
  if (file.name !== "") return file.name;
  const subtype = file.type.split("/")[1];
  return subtype === undefined || subtype === "" ? "pasted" : `pasted.${subtype}`;
}

async function thumbnailOf(path: string): Promise<string | undefined> {
  try {
    const bytes = await invoke<ArrayBuffer>("read_attachment", { path });
    return URL.createObjectURL(new Blob([bytes]));
  } catch {
    return undefined;
  }
}

/** A pasted file has no path yet, so the run's `files/` directory takes its bytes. */
export async function attachPaste(runId: string, file: File): Promise<Attachment> {
  const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
  const path = await invoke<string>("write_run_file", { id: runId, name: nameFor(file), bytes });
  return {
    path,
    name: nameOf(path),
    thumbnail: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
  };
}

/** A dropped file keeps the path it already has. Nothing is copied. */
export async function attachPath(path: string): Promise<Attachment> {
  const name = nameOf(path);
  return { path, name, thumbnail: isImage(name) ? await thumbnailOf(path) : undefined };
}

/** One path per line, then the typed text. The agent opens the files itself. */
export function bodyOf(files: Attachment[], text: string): string {
  return [...files.map((file) => file.path), text].filter((part) => part.trim() !== "").join("\n");
}

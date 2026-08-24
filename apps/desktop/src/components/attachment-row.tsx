import { FileIcon, XIcon } from "lucide-react";

import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "@workspace/ui/components/attachment";
import { cn } from "@workspace/ui/lib/utils";

import type { Attachment as Attached } from "@/lib/attachments";

type PreviewProps = {
  file: Attached;
  onRemove: ((file: Attached) => void) | undefined;
};

function AttachmentPreview({ file, onRemove }: PreviewProps) {
  const image = file.thumbnail !== undefined;

  return (
    <Attachment className={cn(image && "min-w-0")}>
      <AttachmentMedia variant={image ? "image" : "icon"}>
        {file.thumbnail === undefined ? (
          <FileIcon />
        ) : (
          <img src={file.thumbnail} alt={file.name} />
        )}
      </AttachmentMedia>
      {image ? null : (
        <AttachmentContent>
          <AttachmentTitle>{file.name}</AttachmentTitle>
        </AttachmentContent>
      )}
      {onRemove ? (
        <AttachmentActions>
          <AttachmentAction aria-label={`Remove ${file.name}`} onClick={() => onRemove(file)}>
            <XIcon />
          </AttachmentAction>
        </AttachmentActions>
      ) : null}
    </Attachment>
  );
}

type AttachmentRowProps = {
  files: Attached[];
  onRemove?: (file: Attached) => void;
  className?: string;
};

/** A thumbnail for an image, an icon and the file name for anything else. */
export function AttachmentRow({ files, onRemove, className }: AttachmentRowProps) {
  if (files.length === 0) return null;

  return (
    <AttachmentGroup className={className}>
      {files.map((file) => (
        <AttachmentPreview key={file.path} file={file} onRemove={onRemove} />
      ))}
    </AttachmentGroup>
  );
}

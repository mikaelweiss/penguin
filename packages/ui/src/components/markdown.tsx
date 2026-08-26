import * as React from "react"
import { Streamdown } from "streamdown"

import { cn } from "@workspace/ui/lib/utils"

function Markdown({
  className,
  ...props
}: React.ComponentProps<typeof Streamdown>) {
  return (
    <Streamdown
      data-slot="markdown"
      /* Every message arrives whole, so the repair only ever mangles a bracket that meant itself. */
      parseIncompleteMarkdown={false}
      className={cn(
        "font-sans text-sm/6 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className
      )}
      {...props}
    />
  )
}

export { Markdown }

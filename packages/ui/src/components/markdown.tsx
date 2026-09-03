import * as React from "react"
import remarkBreaks from "remark-breaks"
import { Streamdown, defaultRemarkPlugins } from "streamdown"

import { cn } from "@workspace/ui/lib/utils"

/* A run writes prose, not markdown. A newline it wrote is a newline it meant. */
const remarkPlugins = [...Object.values(defaultRemarkPlugins), remarkBreaks]

function Markdown({
  className,
  ...props
}: React.ComponentProps<typeof Streamdown>) {
  return (
    <Streamdown
      data-slot="markdown"
      /* Every message arrives whole, so the repair only ever mangles a bracket that meant itself. */
      parseIncompleteMarkdown={false}
      remarkPlugins={remarkPlugins}
      className={cn(
        "font-sans text-sm/6 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className
      )}
      {...props}
    />
  )
}

export { Markdown }

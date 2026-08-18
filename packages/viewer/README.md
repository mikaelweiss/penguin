# @mikaelweiss/penguin-viewer

The protocol client for a penguin run directory.

A run is a live process whose history is files on disk. This package reads those files: it projects `events.jsonl` into a tree, follows the file live, and writes `inbox.jsonl`. It does not draw.

Any UI that attaches to a run uses this package, so the engine stays a process and the terminal stays a viewer. A late attach sees the same story a live one saw.

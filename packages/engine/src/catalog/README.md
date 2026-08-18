# catalog

**What.** What penguin can use, and where it lives: workflow, adapter, and skill files across catalog directories, plus the homes install writes.

**Why.** Listing and loading definitions is not executing a run. The project, the home, and enabled catalogs are one ordered scan, and earlier wins.

`starter.ts` writes the catalog the binary carries to `~/.penguin/starter/`, and `starter.generated.ts` is that catalog, built from `examples/`.

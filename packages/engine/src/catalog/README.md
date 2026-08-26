# catalog

**What.** Where definitions live, and how they are found: workflow files, adapter files, and skill folders across catalog directories.

**Why.** Listing and loading definitions is not executing a run. The project (`.penguin/`), the home (`~/.penguin/`), enabled catalogs, and the other git checkouts of the project are one ordered scan, and earlier wins.

The starter catalog is the package's `examples/` directory.

Reading a catalog also writes the files an editor needs to type it: `tsconfig.json`, `penguin-env.d.ts`, and the `.gitignore` that keeps their machine paths out of a repository.

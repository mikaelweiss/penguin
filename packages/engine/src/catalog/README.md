# catalog

**What.** Where definitions live, and how they are found: workflow files, adapter files, and skill folders across catalog directories.

**Why.** Listing and loading definitions is not executing a run. The project (`.penguin/`), the home (`~/.penguin/`), enabled catalogs, and the other git checkouts of the project are one ordered scan, and earlier wins.

A worktree catalog may only add a name. An adapter from a branch is inert until a config line names it for its role, and dropped anyway unless it is the sole claim on that role, because every installed role is built with the keychain and the shell before a workflow's own code runs. A skill from a branch is dropped when any other catalog supplies that name, and a file on a branch that refuses to load is skipped rather than thrown, so nothing on a branch changes what the project already resolves.

The starter catalog is the package's `examples/` directory.

Reading a catalog also writes the files an editor needs to type it: `tsconfig.json`, `penguin-env.d.ts`, and the `.gitignore` that keeps their machine paths out of a repository.

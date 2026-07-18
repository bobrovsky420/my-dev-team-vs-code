---
name: run
sideEffecting: true
previewArg: command
---

Run a shell command (e.g. tests, build, git) in the workspace root. Commands execute on {{os}} via {{shell}}; write the command in {{shell}} syntax, never for another operating system.

Set "dangerous" to true when the command is destructive or irreversible - it deletes or overwrites files, rewrites or force-pushes history, resets working state, drops data, or otherwise cannot be easily undone (rm -rf, git reset --hard, git push --force, dropping a database). The user is warned and approves such commands separately, so leave it off for ordinary reads, builds, tests, and installs.

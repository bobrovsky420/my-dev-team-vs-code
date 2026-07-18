---
name: write
sideEffecting: false
previewArg: path
snippetArg: contents
---

Create or overwrite a file. Because it takes the whole new contents rather than
matching existing text, write is also the reliable way to change a line whose
only difference is in special characters (a literal backslash, or straight vs.
curly quotes), which the edit tool can fail to apply. In a multi-root workspace,
prefix the path with its folder's name (e.g. backend/src/app.ts), exactly as the
search tool lists it.

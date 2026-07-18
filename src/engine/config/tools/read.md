---
name: read
sideEffecting: false
previewArg: path
---

Read the text of one workspace file, up to a generous per-call line cap
(typically a couple hundred lines). Optional startLine/endLine (1-based,
inclusive) select a range; without them the file is read from the start up to
the cap. Prefer few large reads over many small ones: request as much as you
expect to need in a single call - omit the range to read from the start, or
pass a wide range - rather than paging a file in small windows, which wastes
steps. When a result does not cover the whole file it begins with the range
shown, the file's total line count, and the startLine to continue with; read on
from there only when you actually need more. To jump to a known region of a
large file, find the relevant lines with the "search" tool first. In a
multi-root workspace a path is prefixed with its folder's name (e.g.
backend/src/app.ts), as the search tool lists it; pass the path exactly as a
tool result gives it.

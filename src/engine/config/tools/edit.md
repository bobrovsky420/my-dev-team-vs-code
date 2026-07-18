---
name: edit
sideEffecting: false
previewArg: path
snippetArg: newText
---

Replace text in an existing file. Give the exact text to replace (oldText)
copied verbatim from the file, and its replacement (newText). oldText must
match exactly one place in the file - include enough surrounding lines to
make it unique. Read the file first and copy oldText from what you read.
Prefer this over "write" for a small targeted change; when the change
rewrites most of the file, use "write" with the complete new contents
instead. oldText is matched byte for byte against the file: if the only
difference between oldText and newText is in special characters (a literal
backslash, or straight vs. curly quotes), the edit can fail to apply because
those characters do not survive being passed as arguments - use "write" with
the complete new contents for such a change instead. In a multi-root
workspace, prefix the path with its folder's name (e.g. backend/src/app.ts),
exactly as the search tool lists it.

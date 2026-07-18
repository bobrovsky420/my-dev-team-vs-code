# Advanced planning requests

The deliverable is a multi-file or workspace-aware change. A good plan here
starts with exploration steps (search/read) before any edit or command, and
may use most of the 8-step budget.

On runs this long the agent prints a **Progress** checklist from time to time
as it works: the plan steps with each one's status, the done ones ticked off
and the current one marked in progress. It shows up inline in the execution
output, so you can glance at where things stand without reading every tool
call. The agent decides when to show it - it does not pause the work or add
steps, it just reports. The examples below are the kind of multi-step request
where you will see it update a few times before the run finishes.

## Multi-file project from scratch

```
@devteam create a small python project "contacts": a Contact dataclass in models.py, a ContactBook class in book.py that can add, remove, search by name, and save/load to contacts.json, and a console menu in main.py that wires it together; then run main.py to check it starts
```

## Refactor guided by the existing code

```
@devteam find every place in src/ that calls fetchUser and change them to use the new getUser(id, options) signature; update the corresponding tests so npm test still passes
```

## Add a feature to an existing codebase

```
@devteam add a /health endpoint to the express server in this repo that returns the package version and uptime as JSON; find where routes are registered, follow the same style, and add a unit test next to the existing route tests
```

## Investigate, then fix

```
@devteam the test in test/parser.test.ts named "handles empty input" is failing; read the test and the parser it covers, find the cause, fix the parser without changing the test's expectations, and run the tests to confirm
```

## Cross-cutting cleanup

```
@devteam search the project for console.log calls outside test files, replace them with the logger from src/log.ts (importing it where missing), and run the linter to make sure nothing broke
```

## A sequential session

The four prompts below are meant to be run in order in the same empty folder.
Each one builds on what the previous left behind, so the agent has to explore
the existing code before it changes anything - exactly the case where the
**Progress** checklist earns its keep. Together they walk one small project
from a clean slate, through an update and a new requirement, to a bug fix.

### 1. Stand up the project (6+ files)

```
@devteam create a python project "library" for a small lending library: a Book dataclass in models.py and a Member dataclass in members.py; a Catalog class in catalog.py that adds books and finds them by title or author; a Loans class in loans.py that checks a book out to a member, returns it, and lists who has what, persisting everything to library.json via a small store in storage.py; and a console menu in main.py that wires it all together. Then run main.py to confirm it starts.
```

### 2. Update the behaviour

```
@devteam in the library project, give each Member a borrowing limit of 3 books and make Loans refuse a checkout that would exceed it with a clear message instead of allowing it; also record the checkout date on each loan and have the "who has what" listing show how many days each book has been out. Update main.py's menu wording to match, and run it to check the new limit triggers.
```

### 3. Add a bigger requirement (3+ new files)

```
@devteam add reservations to the library project: a Reservation dataclass in reservations.py and a Reservations manager in reservation_book.py that lets a member reserve a title that is currently on loan and keeps a per-title waiting queue, plus a notifier.py that, when a book is returned, prints which member is next in line for it. Hook returns in loans.py into the notifier, add the reserve and "show my reservations" actions to main.py, and persist reservations through the existing store in storage.py.
```

### 4. Simulate a bug, then fix it

```
@devteam there's a bug in the library project: when a member returns a book and someone is waiting for it, the reservation stays in the queue, so the same book can be reserved twice and the notifier keeps naming a member who already got it. Read loans.py, reservation_book.py, and notifier.py, find where the fulfilled reservation should be cleared from the queue, fix it so a return pops the next member off and removes their reservation, and run main.py through a reserve/return cycle to confirm the queue empties correctly.
```

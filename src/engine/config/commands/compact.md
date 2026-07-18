---
name: compact
description: Summarize the conversation so far; the summary then stands in for it.
intent: oneshot
---

The user invoked /compact. The engine handles this command on its own path (it
runs the dedicated compacter agent over the conversation - see
config/agents/compacter.md), so this preamble is not used to drive the summary.
It is kept only so the command is registered for autocomplete and route-pinning.

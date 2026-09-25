---
description: Turn the jev tools on or off, or show calls and cost
argument-hint: on | off | status
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bundle/cli.js":*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bundle/cli.js" $ARGUMENTS`

Show the output above to the user verbatim. Add nothing else.

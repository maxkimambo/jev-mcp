# jev-mcp

An MCP server that exposes [TypeSafe Jev](https://docs.typesafe.ai) as typed judgment tools.

Jev is a System One model. It returns a typed answer and a calibrated probability
distribution, never prose. These tools surface that faithfully rather than hiding
it behind a label.

## Install

Requires Node 20.12+ and a TypeSafe API key from
[console.typesafe.ai](https://console.typesafe.ai/settings/keys).

### Claude Code plugin

One marketplace add, one install. This registers the server and the agent skill
together, so there is no separate skill step.

```bash
/plugin marketplace add rashedInt32/jev-mcp
/plugin install jev@jev-mcp
```

The plugin runs the published package through `npx -y jev-mcp@<version>`, so nothing
needs building. The first launch downloads the package, so allow a few seconds before
the server shows as connected in `claude mcp list`.

### Any MCP client

```bash
claude mcp add --scope user jev -- npx -y jev-mcp
```

Or in a client's JSON config:

```json
{
  "mcpServers": {
    "jev": { "command": "npx", "args": ["-y", "jev-mcp"] }
  }
}
```

Do not register the server directly **and** install the plugin. Two servers named
`jev` will otherwise both register.

### The key

The server reads the key from `TYPESAFE_API_KEY` in its environment, then from
`JEV_API_KEY`, then from `~/.config/typesafe/key`. It is never a tool argument, so it
cannot land in a transcript or in a model's context.

The key file is the most reliable source, because some MCP clients strip the
environment before spawning servers:

```sh
mkdir -p ~/.config/typesafe
printf '%s' "ts_..." > ~/.config/typesafe/key
chmod 600 ~/.config/typesafe/key
```

If you prefer the variable, put it in `~/.zshenv` rather than in any repo, and make
sure it is **exported**. Without `export` the variable exists only in the shell that
read it, and every server Claude Code spawns fails with a missing-key error.

### Plugin internals

The server is declared **inline** under `mcpServers` in `.claude-plugin/plugin.json`.
There is no `.mcp.json` anywhere in the repo, and that is deliberate.

A `.mcp.json` at the plugin root is auto-discovered by the plugin loader, so it works.
But any session opened in this directory *also* reads that same file as a project
config, where `${CLAUDE_PLUGIN_ROOT}` is undefined. The result is a missing-variable
warning and a scope conflict on the same server name. The inline form has exactly one
loader and produces neither. Verify with `claude mcp list`: the server appears as
`plugin:jev:jev` and the diagnostics section stays empty.

One trap. `claude plugin details jev` reports `MCP servers (0)` for an inline
declaration even while the server is connected and working. That is a gap in the
inventory count, not a failure. Trust `claude mcp list` over `plugin details` here.

The plugin deliberately ships **no `env` block**. Naming the key there would expand to
an empty string when the variable is unset, and an empty string is not nullish, so it
would shadow the `~/.config/typesafe/key` fallback and turn a working setup into a
missing-key error. Leaving `env` out keeps all three key sources live.

## Tools

| Tool | Primitive | Use when |
| --- | --- | --- |
| `jev_classify` | Choice | The answer is one of a fixed set you define |
| `jev_score` | Score | The answer is a degree on an ordered scale |
| `jev_check` | Noul | The answer is yes or no, and you want the probability |
| `jev_ask` | all three | You have several questions about the same state |
| `jev_models` | — | Confirm the key works and find a model id |

Every tool returns the full probability distribution alongside the answer, plus
`confidence` for Choice and Score. Results come back as MCP structured content, so a
client gets typed data rather than a JSON string to re-parse.

### Prefer `jev_ask`

Jev prefills the state once and scores every question in a single forward pass, so
extra questions add almost no latency or cost. TypeSafe's own
[measurement](https://docs.typesafe.ai/cookbooks/parallel_questions) on a
document-dominated workload puts one batched call at 12.2x cheaper and 10.0x faster
than one call per question, with no change in the answers.

Questions in one request cannot see each other's answers. State any speculative
premise explicitly and let your own code decide which answers apply.

## Design rules

1. **The caller owns the option set.** `jev_classify` requires options from you, so
   the model can pick the wrong one but can never invent one. A selector cannot
   choose a candidate the enumerator dropped. This is the single most common way
   these integrations fail.
2. **Probabilities are always returned.** Not just the winner.
3. **The key lives in the environment.** Never in an argument.
4. **Nothing is silently dropped, overwritten, or truncated.** A request that cannot
   be honoured exactly fails with a reason instead of quietly changing meaning.
5. **Only JSON-RPC reaches stdout.** Logs go to stderr, always.

### The no-match option

Each selecting tool adds a `none` option by default so the model can decline rather
than being forced to pick. Turn it off with `add_none: false` when one option must
always apply.

If you already use the name `none` for an option of your own, the added option takes
a different key instead of overwriting yours, and the response reports which key
carries the no-match meaning in `none_option`. Your option and its probability always
survive intact.

### Confidence gating

Choice and Score answers include an `action` of `act`, `review`, or `abstain`, derived
from `confidence` and the thresholds you pass in `act_above` and `review_above`
(defaults 0.8 and 0.5). `jev_check` returns a `verdict` of `yes`, `no`, or `uncertain`
from `yes_at_or_above` and `no_at_or_below` (defaults 0.7 and 0.3).

These defaults are starting points, not universal rules. Calibrate them on your own
data and on what it costs to be wrong; a destructive action deserves a higher bar than
a read-only one. Confidence describes how concentrated the distribution is. It is not
a claim that the answer is correct.

A Noul near 0.5 means yes and no are close to equally likely, not that the answer is
"medium", which is why the middle band reports `uncertain` rather than rounding.

### Errors

Failures come back with `isError` and a classified body: `kind`, `retryable`, and
where available `status`, `requestId`, and a `hint`. A rejected key (`authentication`,
never retryable) is distinguishable from a rate limit (`rate_limit`, retryable) and
from a malformed question (`invalid_request`). The SDK already retries 408, 429, and
5xx with backoff before an error surfaces here.

### Limits

A Choice question accepts at most 255 options, which is an API limit; past that,
search in two passes, one question picking a window and a second ranking within it.
Question count and state size are local caps that bound cost on a single call, and
both are configurable. Oversized state is rejected rather than truncated, because
truncating silently changes the material the judgment rests on.

## Agent skill

`skills/jev/SKILL.md` teaches an agent when to reach for these tools and how to shape
the call. It is a bridge, not a tutorial. Primitive semantics, state design, and
composition patterns live in TypeSafe's own `typesafe-ai` skill and in the docs, so
this one deliberately does not repeat them.

Its first section is a three-way test: answer it yourself, call a tool, or write SDK
code. That test follows the same line as [When not to reach for this](#when-not-to-reach-for-this)
below, so an agent loading the skill does not end up arguing with this README.

Point your client at the directory, or copy the file to `~/.claude/skills/jev/`.

## Configuration

| Variable | Effect |
| --- | --- |
| `TYPESAFE_API_KEY` | Required. `JEV_API_KEY` also works. |
| `JEV_MODEL` | Model id. Defaults to `jev-latest`. |
| `JEV_TIMEOUT_MS` | Per-attempt timeout. Defaults to 15000. |
| `JEV_MAX_QUESTIONS` | Questions per `jev_ask`. Defaults to 64. |
| `JEV_MAX_STATE_CHARS` | Largest state accepted. Defaults to 200000. |
| `TYPESAFE_LOG_LEVEL` | SDK verbosity. Safe at any level; all output goes to stderr. |

An unusable value for any numeric setting falls back to the default and warns on
stderr, rather than becoming `NaN` and disabling the limit it was meant to enforce.

## Troubleshooting

**Every call reports a missing key.** Some MCP clients filter the environment before
spawning servers, which drops `TYPESAFE_API_KEY`. Confirm the variable is exported,
then pass it explicitly in the client's server config if it still does not arrive.
Run `jev_models` to check the key in isolation.

**The server connects and then dies.** On a stdio transport, anything written to
stdout that is not JSON-RPC breaks the connection. This server routes all logging to
stderr, so `TYPESAFE_LOG_LEVEL=debug` is safe to turn on while debugging.

## When not to reach for this

Jev earns its place on a decision that repeats thousands of times inside software,
where code can enumerate the options first and you need a number to threshold on.

For a one-off judgment during a conversation, an ordinary model answer is usually
better, because it comes with reasoning you can argue with. Jev gives you a number
and a label. That is a feature at scale and a limitation in dialogue.

If deterministic code already decides the case correctly, keep the deterministic
code. Typed output guarantees the interface, not the truth. Measure before adopting.

## Development

```bash
npm ci
npm run build
npm run typecheck
npm test          # offline: unit tests plus regression tests against a local stand-in
npm run test:e2e  # live, requires TYPESAFE_API_KEY
```

To run your local build instead of the npm release, register it directly and skip
the plugin, since the plugin always launches the published version:

```bash
claude mcp add --scope user jev -- node /absolute/path/to/jev-mcp/dist/index.js
```

Releasing: bump `version` in `package.json`, `.claude-plugin/plugin.json`, and
`.claude-plugin/marketplace.json` together, then `npm publish`. The plugin cache is
keyed by version, so an unbumped plugin keeps serving the old snapshot.

The offline suite runs the real built server over stdio against a local stand-in for
the TypeSafe API and asserts on the request bodies it actually sends, so a regression
in what reaches the model fails the build.

## License

MIT

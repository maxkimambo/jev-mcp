# jev-mcp

An MCP server that exposes [TypeSafe Jev](https://docs.typesafe.ai) as typed judgment tools.

Jev is a System One model. It returns a typed answer and a calibrated probability
distribution, never prose. These tools surface that faithfully rather than hiding
it behind a label.

## Install

Requires Node 20.12+ and a TypeSafe API key from
[console.typesafe.ai](https://console.typesafe.ai/settings/keys).

```bash
npm install
npm run build
```

Register with Claude Code:

```bash
claude mcp add --scope user jev -- node /absolute/path/to/jev-mcp/dist/index.js
```

The key is read from `TYPESAFE_API_KEY` in the server's environment. It is never a
tool argument, so it cannot land in a transcript or in a model's context. Put it in
`~/.zshenv` rather than in any repo, and make sure it is **exported**:

```sh
export TYPESAFE_API_KEY="ts_..."
```

Without `export` the variable exists only in the shell that read it. Child processes,
including every MCP server Claude Code spawns, never see it, and every tool call fails
with a missing-key error.

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
npm run typecheck
npm test          # offline: unit tests plus regression tests against a local stand-in
npm run test:e2e  # live, requires TYPESAFE_API_KEY
```

The offline suite runs the real built server over stdio against a local stand-in for
the TypeSafe API and asserts on the request bodies it actually sends, so a regression
in what reaches the model fails the build.

## License

MIT

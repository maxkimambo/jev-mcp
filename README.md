# jev-mcp

An MCP server that exposes [TypeSafe Jev](https://docs.typesafe.ai) as typed judgment tools.

Jev is a System One model. It returns a typed answer and a calibrated probability
distribution, never prose. These tools surface that faithfully rather than hiding
it behind a label.

## Install

Requires Node 20.12+, [ripgrep](https://github.com/BurntSushi/ripgrep) on PATH for
`jev_search`, optionally [trafilatura](https://github.com/adbar/trafilatura) and
[markitdown](https://github.com/microsoft/markitdown) for `jev_rank_pages`
(`uv tool install trafilatura` and `uv tool install 'markitdown[pdf,docx,pptx,xlsx]'`), and
a TypeSafe API key from
[console.typesafe.ai](https://console.typesafe.ai/settings/keys).

### Claude Code plugin

The plugin runs this checkout's build, so build it first, then install from the
directory:

```bash
make build
claude plugin marketplace add /path/to/jev-mcp
claude plugin install jev@jev-mcp
```

Then, in a session, `/jev:jev on`. The tools are **off by default**: while off, every tool
refuses and sends nothing. `/jev:jev off` switches back, `/jev:jev status` shows calls, tokens,
cost and latency by tool.

Besides the server and the skill, the plugin adds two hooks that only fire while jev is
on:

- `UserPromptSubmit` reminds the agent which jev tool replaces which read.
- `PreToolUse` refuses the **first** `Grep`, or `rg`/`grep` in `Bash`, after each prompt
  and tells the agent to use `jev_search` instead. A later search in the same turn runs,
  so an exact-string lookup or a fallback when Jev fails costs one retry. Calling any
  jev tool first lifts the refusal. Hints alone did not work: they arrive after the
  search has already run. Whole-file `Read`s over 16 kB get a hint pointing to
  `jev_locate`, never a refusal.

Switch and ledger live in `~/.claude/jev-think/` (`JEV_HOME` overrides it), shared
between the `/jev` command and the server through `JEV_SWITCH_FILE` and `JEV_LEDGER`.
Claude Code runs a copy made at install time (`~/.claude/plugins/cache/`), so after
`make build` bump the version and reinstall, or the old build keeps running. The command
is `/jev:jev on|off|status`; plugin commands are always prefixed with the plugin name.

### Any MCP client

```bash
claude mcp add --scope user jev -- node /absolute/path/to/jev-mcp/dist/index.js
```

Or in a client's JSON config:

```json
{
  "mcpServers": {
    "jev": { "command": "node", "args": ["/absolute/path/to/jev-mcp/dist/index.js"] }
  }
}
```

Do not register the server directly **and** install the plugin. Two servers named
`jev` will otherwise both register.

### The key

A TypeSafe key (`ts_…`) or an [OpenRouter](https://openrouter.ai/~typesafe/jev-latest)
key (`sk-or-…`) works. An OpenRouter key is routed to `https://openrouter.ai/api` with
model `~typesafe/jev-latest`; `TYPESAFE_BASE_URL` and `JEV_MODEL` override both. The key
is never a tool argument, so it cannot land in a transcript or a model's context.

The server reads `TYPESAFE_API_KEY`, then `JEV_API_KEY`, then `OPENROUTER_API_KEY` from
its environment, then the key file `$XDG_CONFIG_HOME/jev/api_key` (by default
`~/.config/jev/api_key`; `JEV_KEY_FILE` overrides the path).

Prefer the file. An MCP server gets its client's environment, not your shell's, so a
key exported from a shell profile usually never arrives. Create it without the key
touching your shell history or another process's argv, and with 0600 from the start:

```sh
mkdir -p -m 700 ~/.config/jev
(umask 077 && read -rs key && printf '%s' "$key" > ~/.config/jev/api_key)
```

Paste the key at the silent prompt and press Enter. As with ssh, the server refuses a
key file that someone else owns or that group or others can read, and says to
`chmod 600` it. The tools also refuse to read anything under `~/.config/jev/` as a
file, so the key cannot be sent to Jev by path. Rotate by overwriting the file; the
next session picks it up.

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

The plugin's `env` block sets only the switch and ledger paths, never the key. Naming
the key there would expand to an empty string when the variable is unset, and an empty
string is not nullish, so it would shadow the key-file fallback and turn
a working setup into a missing-key error. Claude Code does not usually export an
OpenRouter key to plugin servers, so the key file is the dependable route.

## Tools

| Tool | Primitive | Use when |
| --- | --- | --- |
| `jev_classify` | Choice | The answer is one of a fixed set you define |
| `jev_score` | Score | The answer is a degree on an ordered scale |
| `jev_check` | Noul | The answer is yes or no, and you want the probability |
| `jev_ask` | all three | You have several questions about the same state |
| `jev_triage` | all three, per item | You have many items and want one result each, with files read server-side |
| `jev_locate` | Choice + Noul per question, per window | You need the lines of one large file that answer your questions, without reading it |
| `jev_search` | Choice + Noul per question, per window | You need the lines across a directory that answer your questions, instead of pages of grep hits |
| `jev_extract` | Choice + Noul per question over regex-found values | You want short values from a file (port, version, URL, date, quoted setting) without reading it |
| `jev_rank_pages` | one Noul per question, per page window | You have search results and want the page that answers, before fetching any into your context |
| `jev_screen` | four Nouls + a code check | You are about to read untrusted text and want to know if it tries to steer you |
| `jev_models` | — | Confirm the key works and find a model id |

`jev_rank_pages` fetches up to 20 URLs server-side and never returns their text. It
only fetches https, and refuses any host that resolves to a private, loopback or
link-local address, checked on the connection itself and again on every redirect, so
a search result cannot point it at your LAN or a cloud metadata endpoint. It asks for
markdown first (`Accept: text/markdown`), which docs platforms usually serve. HTML goes
through trafilatura, which keeps the main content and drops menus, footers and ads, and
falls back to plain text without it. PDF and Office documents go through markitdown.
Both converters read the already-fetched bytes on stdin and never fetch anything
themselves.
Pages above four windows are skipped as too long to judge.

`jev_search`, `jev_locate` and `jev_extract` take up to 16 `questions` and send each window
once with all of them, since the text dominates the request
([parallel questions](https://docs.typesafe.ai/cookbooks/parallel_questions)); results
come back one per question, in order.

`jev_search` runs ripgrep over a directory server-side, so git's ignore rules, `.ignore`
files, and hidden and binary files are handled as `rg` handles them; credential files
are filtered out before anything is sent. Lines matching an optional regex (Rust
syntax) become candidates, Jev ranks them with their neighbours, and hits come back
as `path`, `line` and the line's text.
`jev_extract` offers Jev only values that a regex found in the file, so it can pick
the wrong one but never invent one. `jev_screen` asks fixed signals (instructions
aimed at an AI, overriding instructions, exfiltration, hidden instructions) and counts
invisible Unicode in code; any hidden character makes the verdict `suspicious`.

`jev_ask` takes `paths` instead of `state` to ask about files you have not read: the
server reads them and Jev sees one state keyed by path. Every tool is annotated
read-only, so clients may run it in parallel with other reads.

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

### Triage many items without reading them

`jev_triage` asks one question set about many items in a single call and returns one
result per item, in input order. An item is either `text` you already hold or a
`path` the server reads itself. File contents go to Jev and never enter the agent's
context; the agent sees only the answers. That is what makes triage cheap: screen
forty files, then open the three that matter.

```json
{
  "query": "Find where retry backoff for the payments client is configured",
  "items": [
    { "id": "client", "path": "src/payments/client.ts" },
    { "id": "config", "path": "src/config/http.ts" },
    { "id": "notes", "text": "Backoff was moved to the shared HTTP layer in March." }
  ]
}
```

`query` is shorthand for one check named `relevant`. Replace it with `questions` for
typed judgments; the shape is the same as `jev_ask`. Each item is its own request,
so `jev_ask`'s batching applies per item: ask everything you need in one pass.

Each result carries either `answers` or an `error`; a bad path or a rate-limited
item fails in place and the rest still return. Check answers carry a `verdict`,
choice and score answers an `action`. The call is an error only when every item
failed. `usage` is summed over the items that succeeded.

File reads are confined:

- A path must sit **below an allowed root**. The default root is the directory the
  server was started in; set `JEV_FILE_ROOTS` to a `path.delimiter`-separated list
  of absolute directories, or to `off` to refuse every `path` item. Relative paths
  resolve against the first root. Containment is checked before and after symlinks
  are resolved, so a link cannot walk out.
- **Credential files are refused** by name wherever they sit: `.env*`, `.ssh`,
  `.aws`, `.gnupg`, `*.pem`, `*.key`, `id_rsa`, `credentials.json`, the server's own
  key file, and similar. This closes the obvious channel for an injected instruction
  to ship a secret to the API.
- Only regular text files are read. Binary, directories, and files above
  `JEV_MAX_STATE_CHARS` fail with a reason. Nothing is truncated.
- No error message ever includes file contents.

Paths arrive from the model, and the model can be steered by text it has read, so
they are treated as untrusted. The result reports `file_roots` so you can see what
the server will and will not touch.

The idea of screening files inside the tool so the agent reads only what matters
comes from Kush Bhuwalka's [jev-sift](https://github.com/kbhuw/jev-sift). This
implementation shares that goal and adds root confinement with a credential deny
list, per-item classified errors, confidence gating, and answer validation.

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
6. **Every answer is checked against the question sent.** A choice that was never
   offered, a distribution over the wrong options, a legend that does not match the
   levels, or a missing answer in a batch is an error of kind `malformed_response`,
   never a result. A caller that trusted the label alone would otherwise execute
   something it never proposed.

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
from a malformed question (`invalid_request`) and from an answer that fails validation
against the question (`malformed_response`, retryable, nothing to act on) and from a
`path` item that cannot be read (`file_access`, never retryable). The SDK
already retries 408, 429, and 5xx with backoff before an error surfaces here.

Every judgment result also carries `latency_ms` for the API round trip, so calibration
notes can record cost alongside confidence.

### Limits

A Choice question accepts at most 255 options, which is an API limit; past that,
search in two passes, one question picking a window and a second ranking within it.
Question count and state size are local caps that bound cost on a single call, and
both are configurable. Oversized state is rejected rather than truncated, because
truncating silently changes the material the judgment rests on.

## Agent skill

`skills/jev-tools/SKILL.md` teaches an agent to let Jev read bulk text and to read only the
answer: which tool replaces which read, how to phrase the question, and how to act on
`act`/`review`/`abstain`. Primitive semantics and state design live in TypeSafe's own
`typesafe-ai` skill and in the docs.

## Configuration

| Variable | Effect |
| --- | --- |
| `TYPESAFE_API_KEY` | Required. `JEV_API_KEY` also works. |
| `JEV_MODEL` | Model id. Defaults to `jev-latest`. |
| `JEV_TIMEOUT_MS` | Per-attempt timeout. Defaults to 5000: a stalled judgment stalls the agent. |
| `JEV_MAX_RETRIES` | SDK retries after a failed attempt. Defaults to 0, for the same reason. |
| `JEV_SWITCH_FILE` | Optional. A JSON file `{"enabled": true}`; while it is missing or says otherwise, every tool refuses and sends nothing. Read per call. |
| `JEV_LEDGER` | Optional. A JSONL file that gets one line per call: tool, ok, questions, input tokens, cost, ms, client. Never content. |
| `JEV_MAX_QUESTIONS` | Questions per `jev_ask` or `jev_triage`. Defaults to 64. |
| `JEV_MAX_STATE_CHARS` | Largest state accepted, per item for `jev_triage`. Defaults to 200000. |
| `JEV_MAX_ITEMS` | Items per `jev_triage` call, `paths` per `jev_ask`, windows per `jev_locate`. Defaults to 50. |
| `JEV_CONCURRENCY` | Parallel requests within one `jev_triage` call. Defaults to 4, capped at 16. |
| `JEV_FILE_ROOTS` | Directories `jev_triage`, `jev_ask` `paths` and `jev_locate` may read below. Defaults to the working directory; `off` disables file reads. |
| `JEV_RG_PATH` | ripgrep binary for `jev_search`. Defaults to `rg` on PATH. |
| `JEV_TRAFILATURA_PATH` | trafilatura binary for HTML pages in `jev_rank_pages`. Defaults to `trafilatura` on PATH; without it pages are reduced to plain text. |
| `JEV_MARKITDOWN_PATH` | markitdown binary for PDF and Office pages in `jev_rank_pages`. Defaults to `markitdown` on PATH. |
| `JEV_ALLOW_HOSTS` | Comma-separated hosts `jev_rank_pages` may fetch even though they resolve to private addresses, over http too, e.g. an intranet wiki. Empty by default. |
| `JEV_KEY_FILE` | Key file path. Defaults to `$XDG_CONFIG_HOME/jev/api_key`, i.e. `~/.config/jev/api_key`. Must be 0600 and yours. Always refused as a `path` item. |
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

Do not ask Jev to compute. It is a one-pass chooser with no scratchpad, so counting,
arithmetic, date comparison, and threshold cutoffs are unreliable, and the answer still
comes back with a confident probability. Do that work in code and pass the result in as
a fact. Add a reference date to `state` for any question about "today". See TypeSafe's
[numeric and date limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13).

## Development

```bash
npm ci
npm run build
npm run typecheck
npm test          # offline: unit tests plus regression tests against a local stand-in
npm run test:e2e  # live, requires TYPESAFE_API_KEY
```

Releasing: bump `version` in `package.json`, `.claude-plugin/plugin.json`, and
`.claude-plugin/marketplace.json` together. The plugin cache is keyed by version, so an
unbumped plugin keeps serving the old snapshot.

The offline suite runs the real built server over stdio against a local stand-in for
the TypeSafe API and asserts on the request bodies it actually sends, so a regression
in what reaches the model fails the build.

## License

MIT

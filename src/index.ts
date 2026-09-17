#!/usr/bin/env node
/**
 * jev-mcp — MCP server exposing TypeSafe Jev as typed judgment tools.
 *
 * Jev is a System One model: it returns a typed answer plus a calibrated
 * probability distribution, never prose. These tools surface that faithfully.
 *
 * Rules that shape the whole surface:
 *
 *  1. The caller owns the option set. Every selecting tool requires options
 *     supplied by the caller, so the model can pick the wrong one but can never
 *     invent one. A selector cannot choose a candidate the enumerator dropped.
 *  2. Probabilities are always returned, never just the label.
 *  3. The API key comes from the environment only, never a tool argument.
 *  4. Nothing is silently dropped, overwritten, or truncated. A request that
 *     cannot be honoured exactly fails with a reason.
 *  5. Nothing but JSON-RPC is ever written to stdout.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { choice, noul, score, TypeSafeClient } from "@typesafe-ai/sdk";
import type { EntryType, Question, ScoreCriteria } from "@typesafe-ai/sdk";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  assertStateWithinLimit,
  assertUniqueIds,
  buildChoiceCriteria,
  DEFAULT_MAX_QUESTIONS,
  DEFAULT_MAX_SCORE_LEVELS,
  DEFAULT_MAX_STATE_CHARS,
  DEFAULT_TIMEOUT_MS,
  describeError,
  gateConfidence,
  gateProbability,
  readPositiveInt,
} from "./lib.js";

// Read from package.json so the advertised version cannot drift from the release.
const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    if (typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
  } catch {
    // fall through
  }
  return "0.0.0";
})();

// ── Configuration ───────────────────────────────────────────────────────────

const MODEL = process.env.JEV_MODEL ?? "jev-latest";

/**
 * Every log line goes to stderr.
 *
 * The TypeSafe SDK's default logger uses `console.info` and `console.debug`,
 * which write to stdout. On a stdio transport stdout carries JSON-RPC, so a
 * single verbose log line corrupts the stream and kills the connection.
 * Routing all four levels to stderr makes any TYPESAFE_LOG_LEVEL safe.
 */
const stderrLogger = {
  debug: (message: string, ...args: unknown[]) => console.error("[typesafe-sdk]", message, ...args),
  info: (message: string, ...args: unknown[]) => console.error("[typesafe-sdk]", message, ...args),
  warn: (message: string, ...args: unknown[]) => console.error("[typesafe-sdk]", message, ...args),
  error: (message: string, ...args: unknown[]) => console.error("[typesafe-sdk]", message, ...args),
};

const timeout = readPositiveInt(process.env.JEV_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, "JEV_TIMEOUT_MS");
const maxQuestions = readPositiveInt(process.env.JEV_MAX_QUESTIONS, DEFAULT_MAX_QUESTIONS, "JEV_MAX_QUESTIONS");
const maxStateChars = readPositiveInt(process.env.JEV_MAX_STATE_CHARS, DEFAULT_MAX_STATE_CHARS, "JEV_MAX_STATE_CHARS");
for (const setting of [timeout, maxQuestions, maxStateChars]) {
  if (setting.warning) console.error(`[jev-mcp] ${setting.warning}`);
}

// ── Shared schema pieces ────────────────────────────────────────────────────

/**
 * State accepted by Jev: plain text, or structured data for records and logs.
 *
 * `any` rather than `unknown` on purpose: the SDK constrains state to JsonValue
 * and `unknown` members are not assignable to it. The JSON Schema is identical.
 */
const StateSchema = z
  .union([z.string(), z.record(z.any()), z.array(z.any())])
  .describe("The content to evaluate. A plain string for text, or an object/array for structured data such as a record, a diff, or a chat log.");

/** Instructions accept JSON structure, which helps when a question has parts. */
const InstructionSchema = z
  .union([z.string().min(1), z.record(z.any()), z.array(z.any())])
  .describe("The judgment to make. A string, or an object/array when the question has several labelled parts. This is the only instruction Jev sees, so state it in full.");

/** Option and level descriptions accept the same JSON structure. */
const DescriptionSchema = z.union([z.string(), z.record(z.any()), z.array(z.any()), z.null()]);

const UsageSchema = z.object({ input_tokens: z.number(), output_tokens: z.number() });
const GateSchema = z.enum(["act", "review", "abstain"]);

const ActAbove = z
  .number()
  .min(0)
  .max(1)
  .optional()
  .describe("Confidence at or above which the answer is marked 'act'. Default 0.8. Calibrate on your own data and the cost of being wrong.");
const ReviewAbove = z
  .number()
  .min(0)
  .max(1)
  .optional()
  .describe("Confidence at or above which the answer is marked 'review' rather than 'abstain'. Default 0.5.");

// ── Client ──────────────────────────────────────────────────────────────────

let client: TypeSafeClient | undefined;

/**
 * Fallback source for the key.
 *
 * An MCP server is spawned with the client's own environment, not your shell's,
 * so anything exported from `~/.zshenv` never arrives. Confirmed on the wire: a
 * PreToolUse hook under the same client received `JEV_GUARD`, which is injected
 * through settings `env`, but not `TYPESAFE_API_KEY`, which lives only in the
 * shell profile.
 *
 * A 0600 file reaches every spawn path while keeping the secret out of
 * `~/.claude.json`, out of argv, and out of any repository.
 */
const KEY_FILE = process.env.JEV_KEY_FILE ?? join(homedir(), ".config", "typesafe", "key");

function readKeyFile(): string | undefined {
  try {
    const contents = readFileSync(KEY_FILE, "utf8").trim();
    return contents.length > 0 ? contents : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Built lazily: the constructor throws without a key, and a missing key should
 * produce one clear tool error rather than stop the server from starting.
 */
function getClient(): TypeSafeClient {
  const apiKey = process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY ?? readKeyFile();
  if (!apiKey) {
    throw new Error(
      `No API key. Set TYPESAFE_API_KEY in the environment of the MCP client, or create ${KEY_FILE} with mode 0600. Never pass it as a tool argument.`,
    );
  }
  client ??= new TypeSafeClient({ apiKey, timeout: timeout.value, logger: stderrLogger });
  return client;
}

// ── Result helpers ──────────────────────────────────────────────────────────

/**
 * Tool results carry both a text block and structured content: the text keeps
 * older clients working, the structured payload is validated against the tool's
 * output schema so a caller gets typed data instead of a JSON string to parse.
 */
function ok<T extends Record<string, unknown>>(payload: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function fail(error: unknown) {
  const described = describeError(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ error: described }, null, 2) }],
  };
}

const server = new McpServer({ name: "jev", version: VERSION });

// ── classify: one of a defined set ─────────────────────────────────────────

server.registerTool(
  "jev_classify",
  {
    title: "Classify into one of your options",
    description:
      "Pick exactly one option from a set you define. Returns the chosen option, the probability of every option, a confidence value, and a recommended action gated on confidence. " +
      "Use when the answer is one of a fixed set. The options must be supplied by you: Jev selects among them and cannot invent a new one. Up to 255 options.",
    inputSchema: {
      state: StateSchema,
      question: InstructionSchema,
      options: z
        .record(DescriptionSchema)
        .describe("Map of option name to a description that separates it from the others. Both the name and the description are sent to the model, so keep names short and distinct. A description may be an object or array when structure clarifies it, or null to leave it undescribed."),
      add_none: z
        .boolean()
        .optional()
        .describe("Add a no-match option meaning none of yours fits. Defaults to true. Turn off only when one option must always apply. If you already use the name 'none', the added option takes a different key and it is reported back as none_option."),
      act_above: ActAbove,
      review_above: ReviewAbove,
    },
    outputSchema: {
      choice: z.string(),
      confidence: z.number(),
      probabilities: z.record(z.number()),
      none_option: z.string().nullable().describe("The key carrying the no-match meaning, or null when none was added."),
      action: GateSchema,
      thresholds: z.object({ act_above: z.number(), review_above: z.number() }),
      model: z.string(),
      usage: UsageSchema,
    },
  },
  async ({ state, question, options, add_none, act_above, review_above }, extra) => {
    try {
      assertStateWithinLimit(state, maxStateChars.value);
      const actAbove = act_above ?? 0.8;
      const reviewAbove = review_above ?? 0.5;
      const { criteria, noneKey } = buildChoiceCriteria(options as Record<string, EntryType>, add_none !== false);

      const result = await getClient().systemOne(
        { state, model: MODEL, questions: { classify: choice(question, criteria) } },
        { signal: extra.signal },
      );
      const answer = result.answers.classify;
      return ok({
        choice: answer.choice,
        confidence: answer.confidence,
        probabilities: answer.probabilities,
        none_option: noneKey,
        action: gateConfidence(answer.confidence, actAbove, reviewAbove),
        thresholds: { act_above: actAbove, review_above: reviewAbove },
        model: result.model,
        usage: result.usage,
      });
    } catch (error) {
      return fail(error);
    }
  },
);

// ── score: a position on an ordered scale ──────────────────────────────────

server.registerTool(
  "jev_score",
  {
    title: "Rate on an ordered scale",
    description:
      "Rate the state along an ordered scale you define. Returns a probability-weighted score that can land between levels, the distribution, confidence, and a recommended action. " +
      "Use for degree or severity, not for picking a category.",
    inputSchema: {
      state: StateSchema,
      question: InstructionSchema,
      levels: z
        .array(DescriptionSchema)
        .min(2)
        .describe("Ordered level descriptions, lowest first. At least two. Each level must describe a concrete situation and stand on its own."),
      act_above: ActAbove,
      review_above: ReviewAbove,
    },
    outputSchema: {
      score: z.number(),
      confidence: z.number(),
      probabilities: z.record(z.number()),
      legend: z.record(z.any()),
      action: GateSchema,
      thresholds: z.object({ act_above: z.number(), review_above: z.number() }),
      model: z.string(),
      usage: UsageSchema,
    },
  },
  async ({ state, question, levels, act_above, review_above }, extra) => {
    try {
      assertStateWithinLimit(state, maxStateChars.value);
      if (levels.length > DEFAULT_MAX_SCORE_LEVELS) {
        throw new Error(`levels must contain at most ${DEFAULT_MAX_SCORE_LEVELS} entries; received ${levels.length}.`);
      }
      const actAbove = act_above ?? 0.8;
      const reviewAbove = review_above ?? 0.5;

      const result = await getClient().systemOne(
        // zod already enforces two or more levels; the SDK types that as a tuple.
        { state, model: MODEL, questions: { rating: score(question, levels as unknown as ScoreCriteria) } },
        { signal: extra.signal },
      );
      const answer = result.answers.rating;
      return ok({
        score: answer.score,
        confidence: answer.confidence,
        probabilities: answer.probabilities,
        legend: answer.legend,
        action: gateConfidence(answer.confidence, actAbove, reviewAbove),
        thresholds: { act_above: actAbove, review_above: reviewAbove },
        model: result.model,
        usage: result.usage,
      });
    } catch (error) {
      return fail(error);
    }
  },
);

// ── check: probability that a condition holds ──────────────────────────────

server.registerTool(
  "jev_check",
  {
    title: "Yes/no with a probability",
    description:
      "Ask a yes/no question. Returns the probability that the answer is yes, from 0 to 1, plus a verdict. There is no separate confidence: a value near 0.5 means yes and no are close to equally likely, not that the answer is 'medium'. " +
      "Use one check per label when several labels may apply at once.",
    inputSchema: {
      state: StateSchema,
      question: InstructionSchema,
      yes_means: DescriptionSchema.optional().describe("What a yes means. Sharpens the judgment."),
      no_means: DescriptionSchema.optional().describe("What a no means."),
      yes_at_or_above: z.number().min(0).max(1).optional().describe("Probability at or above which the verdict is 'yes'. Default 0.7."),
      no_at_or_below: z.number().min(0).max(1).optional().describe("Probability at or below which the verdict is 'no'. Default 0.3. Between the two the verdict is 'uncertain'."),
    },
    outputSchema: {
      probability_yes: z.number(),
      verdict: z.enum(["yes", "no", "uncertain"]),
      thresholds: z.object({ yes_at_or_above: z.number(), no_at_or_below: z.number() }),
      model: z.string(),
      usage: UsageSchema,
    },
  },
  async ({ state, question, yes_means, no_means, yes_at_or_above, no_at_or_below }, extra) => {
    try {
      assertStateWithinLimit(state, maxStateChars.value);
      const yesAt = yes_at_or_above ?? 0.7;
      const noAt = no_at_or_below ?? 0.3;
      if (noAt > yesAt) throw new Error("no_at_or_below must not exceed yes_at_or_above.");

      const criteria =
        yes_means !== undefined || no_means !== undefined
          ? { true: yes_means ?? null, false: no_means ?? null }
          : undefined;

      const result = await getClient().systemOne(
        { state, model: MODEL, questions: { check: criteria ? noul(question, criteria) : noul(question) } },
        { signal: extra.signal },
      );
      const probability = result.answers.check.noul;
      return ok({
        probability_yes: probability,
        verdict: gateProbability(probability, yesAt, noAt),
        thresholds: { yes_at_or_above: yesAt, no_at_or_below: noAt },
        model: result.model,
        usage: result.usage,
      });
    } catch (error) {
      return fail(error);
    }
  },
);

// ── ask: many questions about one state, in a single request ───────────────

server.registerTool(
  "jev_ask",
  {
    title: "Ask many questions about one state",
    description:
      "Ask several independent questions about the same state in ONE request. Jev prefills the state once and scores every question in a single forward pass, so extra questions add almost no latency. " +
      "Prefer this over repeated single-question calls: on a document-dominated workload it is dramatically cheaper and faster with no change in answers. " +
      "Questions cannot see each other's answers, so state any speculative premise explicitly and let your own logic decide which answers apply.",
    inputSchema: {
      state: StateSchema,
      questions: z
        .array(
          z.object({
            id: z.string().min(1).describe("Your key for this question. Returned alongside the answer. Never sent to the model, so put the full meaning in the question itself. Must be unique within the call."),
            type: z.enum(["classify", "score", "check"]),
            question: InstructionSchema,
            options: z.record(DescriptionSchema).optional().describe("Required for type 'classify'."),
            add_none: z.boolean().optional().describe("For 'classify': add a no-match option. Defaults to true."),
            levels: z.array(DescriptionSchema).min(2).optional().describe("Required for type 'score'."),
            yes_means: DescriptionSchema.optional().describe("For 'check': what a yes means."),
            no_means: DescriptionSchema.optional().describe("For 'check': what a no means."),
          }),
        )
        .min(1),
      act_above: ActAbove,
      review_above: ReviewAbove,
    },
    outputSchema: {
      answers: z.record(z.any()).describe("Keyed by your question ids. Choice and Score answers also carry an 'action' gated on confidence."),
      none_options: z.record(z.string().nullable()).describe("For each 'classify' question, the key carrying the no-match meaning, or null."),
      model: z.string(),
      usage: UsageSchema,
    },
  },
  async ({ state, questions, act_above, review_above }, extra) => {
    try {
      assertStateWithinLimit(state, maxStateChars.value);
      if (questions.length > maxQuestions.value) {
        throw new Error(`questions must contain at most ${maxQuestions.value} entries; received ${questions.length}. Raise JEV_MAX_QUESTIONS if that limit is wrong for your workload.`);
      }
      assertUniqueIds(questions.map((q) => q.id));
      const actAbove = act_above ?? 0.8;
      const reviewAbove = review_above ?? 0.5;

      const built: Record<string, Question> = {};
      const noneOptions: Record<string, string | null> = {};

      for (const q of questions) {
        if (q.type === "classify") {
          if (!q.options) throw new Error(`Question '${q.id}' is type 'classify' and needs options.`);
          const { criteria, noneKey } = buildChoiceCriteria(q.options as Record<string, EntryType>, q.add_none !== false, `options for '${q.id}'`);
          built[q.id] = choice(q.question, criteria);
          noneOptions[q.id] = noneKey;
        } else if (q.type === "score") {
          if (!q.levels) throw new Error(`Question '${q.id}' is type 'score' and needs levels.`);
          if (q.levels.length > DEFAULT_MAX_SCORE_LEVELS) {
            throw new Error(`levels for '${q.id}' must contain at most ${DEFAULT_MAX_SCORE_LEVELS} entries.`);
          }
          built[q.id] = score(q.question, q.levels as unknown as ScoreCriteria);
        } else {
          const criteria =
            q.yes_means !== undefined || q.no_means !== undefined
              ? { true: q.yes_means ?? null, false: q.no_means ?? null }
              : undefined;
          built[q.id] = criteria ? noul(q.question, criteria) : noul(q.question);
        }
      }

      const result = await getClient().systemOne({ state, model: MODEL, questions: built }, { signal: extra.signal });

      // Attach the confidence gate where there is a confidence to gate on.
      const answers: Record<string, unknown> = {};
      for (const [id, answer] of Object.entries(result.answers as unknown as Record<string, Record<string, unknown>>)) {
        answers[id] =
          typeof answer?.confidence === "number"
            ? { ...answer, action: gateConfidence(answer.confidence, actAbove, reviewAbove) }
            : answer;
      }

      return ok({ answers, none_options: noneOptions, model: result.model, usage: result.usage });
    } catch (error) {
      return fail(error);
    }
  },
);

// ── models: what this key can actually use ─────────────────────────────────

server.registerTool(
  "jev_models",
  {
    title: "List available models",
    description:
      "List the models this API key can use, with their release dates. Use it to confirm the key works and to find a model id for JEV_MODEL before assuming one exists.",
    inputSchema: {},
    outputSchema: {
      active_model: z.string().describe("The model these tools send requests to."),
      models: z.array(z.object({ name: z.string(), description: z.string(), release_date: z.string() })),
    },
  },
  async (_args, extra) => {
    try {
      const models = await getClient().models.list({ signal: extra.signal });
      return ok({ active_model: MODEL, models });
    } catch (error) {
      return fail(error);
    }
  },
);

// ── Boot ────────────────────────────────────────────────────────────────────

async function main() {
  await server.connect(new StdioServerTransport());
  console.error(`[jev-mcp] ready — version ${VERSION}, model ${MODEL}`);
}

main().catch((error) => {
  console.error("[jev-mcp] failed to start:", error);
  process.exit(1);
});

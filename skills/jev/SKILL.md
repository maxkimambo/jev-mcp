---
name: jev
description: >
  Get typed, calibrated judgments from the connected `jev` MCP tools when the same
  semantic decision repeats across many items — triaging files, ranking candidates,
  checking claims against their sources, scoring a diff against each requirement — or
  when you need a calibrated number to threshold on. Prefer an ordinary answer for a
  single judgment in conversation. Not for judgments that ship inside the user's
  application; those belong in SDK code, not in a tool call.
---

# Jev judgments over MCP

Jev is a System One model. It returns a typed answer and a calibrated probability
distribution, never prose. The `jev` MCP server exposes it as five tools.

This skill covers **when to call those tools and how to shape the call**. For the
underlying theory — primitive semantics, state design, composition patterns — use the
`typesafe-ai` skill or the live docs at <https://docs.typesafe.ai>. Do not duplicate
that material here.

If the `jev_*` tools are not in your tool list, this skill does not apply. Call
`jev_models` to confirm the key works before assuming a failure is your own.

## Three-way test

Decide which of these you are in before calling anything.

**Answer it yourself** when the judgment happens once, in conversation, and you can
explain your reasoning. That is most judgments. An ordinary answer carries an argument
the user can push back on. Jev returns a number and a label, which is weaker in
dialogue. Do not reach for a tool to look rigorous.

**Call the tool** when the same judgment repeats across many items, or when you need a
calibrated number to threshold on. Triaging forty files. Ranking twenty candidates.
Checking fifteen claims against their sources. Scoring a diff against each requirement
in a spec. Enumerate the candidates in code or by hand first; Jev only selects among
what you supply. Nothing is installed and no key is configured; the server holds it.

**Write SDK code** when the judgment runs in the user's application, on their traffic,
after you are gone. Then it belongs in their repo under test, not in a transcript.
Follow the `typesafe-ai` skill for that.

Do not call a tool to prototype what will become shipped code. Write the code.

## Pick the tool

| The answer is | Tool | Notes |
| --- | --- | --- |
| One of a set you define | `jev_classify` | You supply `options`. Jev cannot invent one. |
| A degree on an ordered scale | `jev_score` | You supply `levels`, lowest first, at least two. |
| Yes or no | `jev_check` | Returns the probability of yes. No separate confidence. |
| Several questions, one subject | `jev_ask` | Mixes all three types. Up to 64 questions. |

When several labels can be true at once, that is not one `jev_classify`. It is one
`jev_check` per label, batched through `jev_ask`.

## Prefer `jev_ask`

Jev prefills the state once and scores every question in one forward pass. Extra
questions add almost no latency or cost. One batched call beats a loop by a wide
margin on document-heavy state.

So ask everything you might need, including speculative branches. Questions cannot see
each other's answers, so state any premise explicitly in the question itself. Let your
own reasoning decide which answers apply afterwards.

Give each question a stable `id`. The id is never sent to the model, so the question
must carry its full meaning on its own.

## Shape the call

Put the evidence in `state`. A string for text, an object or array when it has parts.
Include what the question needs to be answerable: the diff, the requirement, the
relevant file, the prior decision.

Put the judgment in `question`. State it in full. This is the only instruction Jev sees.

Describe every option and level concretely. A level must stand on its own without
reading its neighbours. Weak option descriptions are the most common cause of a bad
answer.

Leave `add_none` alone unless one option must always apply. The default no-match option
lets Jev decline rather than being forced into a wrong pick.

## Read the answer

Never act on the label alone. Every response carries the full distribution.

`jev_classify` and `jev_score` return `action`: `act`, `review`, or `abstain`. It is
derived from `confidence` against `act_above` and `review_above`. `jev_check` returns
`verdict`: `yes`, `no`, or `uncertain`.

Treat `review` and `uncertain` as instructions to look at the evidence yourself, not as
a soft yes. Raise the thresholds when being wrong is expensive, and say that you did.

Confidence measures how concentrated the distribution is. It is not a claim that the
answer is correct. Two good options split probability and look uncertain.

For `jev_score`, the number is a position on the `levels` array you supplied. Read
`legend` to map it back.

For `jev_classify`, check `none_option` before interpreting a no-match result. If you
already used the name `none`, the added option took a different key.

## Do not

Do not present a Jev answer as fact. Report the answer, the confidence, and what you
did about it.

Do not batch questions about unrelated subjects. One state, one subject.

Do not use a Score for a category, or a Choice for a degree.

Do not paste secrets, keys, or credentials into `state`.

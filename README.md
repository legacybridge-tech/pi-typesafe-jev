# pi-typesafe-jev

A pi extension that exposes TypeSafe (Jev, System One) judgments as five pi tools, so a model can
make narrow semantic judgments while your code and your users keep control of thresholds, weights,
and actions.

| Tool | Purpose | Returns |
| --- | --- | --- |
| `typesafe_noul` | A yes/no question | `noul` (0..1, the probability that the answer is yes) |
| `typesafe_choice` | Pick one of a fixed set of options | `choice`, `probabilities`, `confidence` |
| `typesafe_score` | Rate along ordered levels | `score`, `legend`, `probabilities`, `confidence` |
| `typesafe_evaluate` | Several independent questions over one state, in one request | One answer per question, plus `usage` |
| `typesafe_ask` | A question pinned in a local YAML/JSON file; the call supplies only the per-call facts | The pinned question's answer (`noul`, `choice`, or `score` shape) |

The tools call `POST https://api.typesafe.ai/v1/systemone` directly with native `fetch`; there is no
SDK runtime dependency. The API key is stored by `/typesafe setup` in your own pi agent directory and
needs no environment variable.

## Install

Install from npm:

```bash
pi install npm:pi-typesafe-jev
```

Alternatively, install it from a local path (replace the path with your checkout):

```bash
# Try it for a single run without writing settings
pi -e /absolute/path/to/pi-typesafe-jev

# Install into user settings (recommended)
pi install /absolute/path/to/pi-typesafe-jev

# Or into project settings
pi install -l /absolute/path/to/pi-typesafe-jev
```

Or add it manually to `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "/absolute/path/to/pi-typesafe-jev"
  ]
}
```

Run `/reload` inside pi (or restart pi) after installing. The extension performs no network access and
reads no credentials when it loads; the credential file is only read when a tool or command actually
runs.

For development in this directory:

```bash
npm install          # dev-only type/check dependencies; nothing global
npm run typecheck    # tsc --noEmit
npm test             # node --test, fully offline
npm pack --dry-run   # inspect exactly which files ship
```

## Configure the API key

```text
/typesafe status    Show whether a key is configured, the model, and the key file path
/typesafe setup     Enter or replace the API key
/typesafe logout    Delete the stored API key
```

`/typesafe setup` behaviour:

- If a key is already stored, it asks before replacing it. Declining leaves the old key untouched.
- If the config file exists but cannot be read (corrupt, unexpected version, not a regular file), it
  reports the problem and asks before overwriting. Nothing is rewritten without confirmation.
- Input is trimmed, and values with whitespace, control characters, non-ASCII characters, or an
  excessive length are rejected. Cancelling or entering nothing keeps the previous key.
- **Input is not masked.** pi's `ctx.ui.input()` has no masking support, so typed characters are
  visible on screen while you type. The key never appears in the transcript, session file, tool
  output, or error messages, and `/typesafe status` shows only the file path, never any part of the key.
- Setup does not call the API to verify the key. A wrong key surfaces on the first `typesafe_*` call
  as `401`, and the tool then tells the user to run `/typesafe setup` again.

Key location (`<agent dir>` defaults to `~/.pi/agent` and follows `PI_CODING_AGENT_DIR`):

```text
<agent dir>/typesafe/config.json
```

- Directory mode `0700`, file mode `0600` (Unix; see the Windows limitation below).
- Writes use a same-directory temporary file plus `rename`, so the file is replaced atomically and is
  never left half-written.
- Reads, writes, and deletes all refuse a symlink, for the credential file and for the `typesafe`
  directory itself. The directory is only used when it is a real directory owned by this extension, so
  a link cannot redirect the permission fix-up, the temporary files, or the deletion to another path.
- The file is **plaintext** JSON. If your threat model requires OS keychain protection, this extension
  does not provide it.

Remove the key with `/typesafe logout` (with confirmation) or by deleting the file yourself.

## Examples

Tools are called by the model, but you can drive them directly. All parameter examples below are
valid JSON.

Yes/no probability:

```json
{
  "state": "Help! My payouts have been failing for 3 days.",
  "instructions": "Does this convey urgency?",
  "criteria": {
    "true": "Explicitly time-sensitive",
    "false": "No urgency expressed"
  }
}
```

Choice over a fixed set (include a no-match option):

```json
{
  "state": {
    "ticket": {
      "subject": "Duplicate charge",
      "messages": [
        { "from": "customer", "text": "I was charged twice for order A-104. Please refund the duplicate." }
      ]
    },
    "refund_policy": "Duplicate charges are eligible for a refund."
  },
  "instructions": "Which team should handle `ticket.subject`?",
  "criteria": {
    "billing": "Payments, invoicing, refunds",
    "technical": "Bugs, outages, integrations",
    "other": "None of the above"
  }
}
```

Ordered levels:

```json
{
  "state": "This is the third time I have asked about this.",
  "instructions": "How frustrated is the customer?",
  "criteria": ["Calm", "Frustrated", "Very angry"]
}
```

Several independent questions in one request (mixed types):

```json
{
  "state": {
    "ticket_message": "My flight was cancelled. Can I get a refund?",
    "refund_policy": "Cancelled flights are eligible for a full refund."
  },
  "questions": [
    {
      "id": "refund_requested",
      "type": "noul",
      "instructions": "Does `ticket_message` request a refund?"
    },
    {
      "id": "request_type",
      "type": "choice",
      "instructions": "What is the main request in `ticket_message`?",
      "criteria": {
        "refund": "The customer wants money returned.",
        "rebooking": "The customer wants a replacement flight.",
        "information": "The customer is asking for information only."
      }
    },
    {
      "id": "frustration",
      "type": "score",
      "instructions": "How frustrated does the customer appear in `ticket_message`?",
      "criteria": ["Calm and neutral.", "Concerned but civil.", "Very angry or using strong language."]
    }
  ]
}
```

Tool output includes the answers, the full probability distributions, `confidence`, and token
`usage`; the `details` field carries the same structured data.

### Question files (`typesafe_ask`)

When the same judgment is asked repeatedly (a router, a classifier, a gate), the rubric should not be
re-typed by the calling model on every call: that costs output tokens and invites the model to
"helpfully" rewrite the criteria. `typesafe_ask` reads the question from a file on disk and takes only
the facts that change from the tool call.

`ticket_router.yaml`:

```yaml
description: which team should handle the latest ticket message
type: choice
instructions: |
  Which team should handle the request in `messages` (newest last),
  given the `account` facts?
criteria:
  billing: Payments, invoicing, refunds.
  technical: Bugs, outages, integrations.
  sales: Pricing, upgrades, new contracts.
  other: None of the above.
state:
  messages: { $bind: messages }
  account: { $bind: account }
  refund_policy: "Duplicate charges are eligible for a refund."
```

Tool call:

```json
{
  "questionFile": "ticket_router.yaml",
  "bind": {
    "messages": ["I was charged twice for order A-104."],
    "account": { "plan": "pro", "open_incidents": 0 }
  }
}
```

Rules:

- The file is the question. `type`, `instructions`, and `criteria` come from the file only; the call
  cannot override them, and a `bind` name that the template does not use is an error.
- `state` is a template. Every `{ $bind: name }` node is replaced by `bind.name`; every other node is
  copied as-is. Slots may appear anywhere in the template, including inside arrays or as the root.
- Every slot must be supplied and every supplied name must be a slot. Both directions fail loudly so a
  typo cannot silently drop a fact.
- `questionFile` may be relative (resolved against the current working directory), absolute, or
  `~/...`. Only `.yaml`, `.yml`, and `.json` are accepted; the file must be a regular file (symbolic
  links are refused) under 256 KiB, and YAML anchors/aliases and merge keys are not expanded.
- Tool output, `details.questionFile`, and error messages show the path relative to the working
  directory (or `~/...`, or just the file name for files elsewhere), never the absolute path, so the OS
  user name and directory layout stay out of model context and session files.
- An optional top-level `description` is echoed in the tool output; any other top-level key is an error.
- The question is validated through the same normalizer as the ad-hoc tools, so the wire request is
  identical to a `typesafe_choice` (or noul / score) call with the same content.

## How to read the results (embedded in the tool descriptions and guidelines)

- **These are judgments, not generated text.** Put facts in `state` and one complete, narrow question
  in `instructions`.
- **One narrow judgment per question.** "Does this message convey urgency?" works. "Analyze this and
  decide the best course of action" does not; split it into small questions and combine the answers in
  your own code.
- **Batch independent questions about the same state.** Use `typesafe_evaluate` once; the questions
  cannot see each other's answers, so make a second request only when a later question genuinely needs
  an earlier answer to fetch new data or to choose new options.
- **Question ids are never sent to the model.** Write the complete question in `instructions`, and
  reference nested state fields with backticked paths such as `` `ticket.messages[0].text` ``.
- **A `noul` value is the probability of yes.** Near `0.5` means yes and no are equally likely, not
  medium intensity; use `typesafe_score` for degree. Noul has no separate confidence field.
- **A `score` is a 0-based position across your ordered levels** and can land between levels; it is
  not a 0..1 value. `legend` maps level numbers back to your descriptions.
- **`confidence` is how concentrated the probability distribution is.** It is not truth and not
  permission to act; keep thresholds, weights, and actions in code or with a human.
- **`typesafe_choice` options are an unordered set.** List every option and add
  `other`/`none of the above`, because the model cannot select a value you never provided.
- If a tool reports that the key is missing or rejected, the user must run `/typesafe setup`; never
  ask for the key in chat.

## Privacy and security design

- Fixed endpoint `https://api.typesafe.ai/v1/systemone`; tools expose no endpoint override, and a
  non-HTTPS URL is only permitted for loopback hosts in tests.
- `redirect: "manual"`: redirects are refused so the bearer token can never be forwarded to another host.
- Requests carry `Authorization: Bearer <key>`, but the key never appears in any error message, tool
  output, or status output. Provider and transport errors pass through redaction (`[redacted]`) before
  they reach the model.
- Only `429` and `529` are retried, with bounded exponential backoff and a capped `Retry-After`. Other
  5xx statuses and transport failures are not retried automatically, because the request may have
  reached the service.
- The connection, the response body read, and the backoff sleeps share a single deadline; response
  bodies are bounded (1 MiB).
- Every 200 response is validated: answer ids and types must match the questions, probabilities must
  cover exactly the options or levels and sum to 1, probabilities and `confidence` must be within
  0..1, `score` must fall inside the level range, `model` must be a short identifier that does not
  repeat the configured API key, and `usage` must
  be present. A response that does not match the contract is reported as a protocol error instead of an
  invented answer, and the error never repeats the returned text. Score legends are rebuilt from the
  level descriptions that were sent, so a response cannot push arbitrary text (including a reflected
  credential) into the model context or the transcript.
- An unreadable or corrupt config file fails closed: tools report the problem and point the user at
  `/typesafe setup`; nothing is overwritten silently, and diagnostics never repeat values taken from
  the config file.
- The extension registers no model or provider (Jev is a tool service, not a chat model), and it never
  reads a key from the environment.

## Known limitations

- **Not verified against the live API.** All tests inject `fetch` and use canned responses; no real
  key was used and no paid call was made. End-to-end online behaviour still needs validation with the
  user's own key.
- `setup` does not verify the key online; a typo surfaces later as `401`.
- The key is plaintext on disk; there is no OS keychain integration.
- **Windows:** `chmod` is effectively a no-op, so `0600`/`0700` are not guaranteed. On a shared
  machine, check the file ACL yourself or avoid storing the key.
- Setup input is not masked (see the setup section above).
- `typesafe_evaluate` has no hard question-count limit, but state and questions share a request budget
  of roughly 32k tokens; `usage` reports what a request consumed.
- Requires `node >= 22.19` (matching an installed pi). The extension is loaded as TypeScript by pi
  (via jiti) and tests run with Node's built-in type stripping, so the source avoids TS syntax that
  needs transformation (enums, namespaces, and similar).
- Tests point `PI_CODING_AGENT_DIR` at a temporary directory and never read or write the real user config.

## License and attribution

MIT licensed; see `LICENSE`.

The tool descriptions and reading guidance are condensed, original restatements of TypeSafe's public
documentation and its MIT-licensed agent skill
(<https://docs.typesafe.ai/llms.txt>, <https://github.com/typesafe-ai/skills>). The wire format follows
the v1 contract in <https://docs.typesafe.ai/api.md>. This is an independent integration and is not
affiliated with TypeSafe AI.

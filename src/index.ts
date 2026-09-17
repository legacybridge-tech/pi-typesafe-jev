/**
 * pi extension: TypeSafe (Jev) judgments as four typed tools.
 *
 *   typesafe_noul      probability that a yes/no condition holds
 *   typesafe_choice    pick one option from a fixed set
 *   typesafe_score     rate along ordered levels
 *   typesafe_evaluate  batch several typed questions over one state
 *
 * `/typesafe setup|status|logout` manages the API key stored by config.ts.
 *
 * The factory only registers tools and a command; it performs no network access
 * and reads no credentials until a tool or command actually runs.
 */

import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  getAgentDir,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  JEV_MODEL,
  MAX_SCORE_LEVELS,
  TypeSafeClient,
  redactSecrets,
  answerFor,
  type Answer,
  type QuestionInput,
  type SystemOneResponse,
  type TokenUsage,
} from "./client.ts";
import {
  CredentialStore,
  TypeSafeConfigError,
  TYPESAFE_CONFIG_DIR_NAME,
  validateApiKey,
} from "./config.ts";

const NOUL_QUESTION_ID = "noul";
const CHOICE_QUESTION_ID = "choice";
const SCORE_QUESTION_ID = "score";

/** Guidance shared by the per-primitive tools, all adapted from the TypeSafe docs. */
const STATE_DESCRIPTION =
  "What to judge: a plain string, or structured JSON (object or array) such as a ticket, a record, or the current state of the application. Carry the facts the question needs; the model receives this state verbatim.";

const StateSchema = Type.Union(
  [
    Type.String({ description: STATE_DESCRIPTION }),
    Type.Record(Type.String(), Type.Unknown(), { description: STATE_DESCRIPTION }),
    Type.Array(Type.Unknown(), { description: STATE_DESCRIPTION }),
  ],
  { description: STATE_DESCRIPTION },
);

const InstructionsSchema = Type.Union(
  [
    Type.String({ description: "The full question to ask about the state." }),
    Type.Record(Type.String(), Type.Unknown(), { description: "A structured question (JSON object) about the state." }),
    Type.Array(Type.Unknown(), { description: "A structured question (JSON array) about the state." }),
  ],
  {
    description:
      "The question to ask. Question ids are never sent to the model, so write the complete question here, including any definition the answer depends on. Reference nested state fields with backticked paths such as `ticket.messages[0].text`.",
  },
);

const ChoiceCriteriaSchema = Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]), {
  description:
    "Every option mapped to a short rubric for when that option applies, or null when no extra detail is needed. Option names and descriptions are sent to the model. Include a no-match option such as \"other\" or \"none of the above\" when the list may not cover every input.",
});

const NoulCriteriaSchema = Type.Object(
  {
    true: Type.Optional(Type.String({ description: "What a near-1 (yes) answer means." })),
    false: Type.Optional(Type.String({ description: "What a near-0 (no) answer means." })),
  },
  { description: "Optional clarification of what the yes and no answers mean." },
);

const ScoreCriteriaSchema = Type.Array(Type.String(), {
  minItems: 2,
  maxItems: MAX_SCORE_LEVELS,
  description:
    "Ordered level descriptions from the low end to the high end (2 to 10 levels). Each level must stand on its own and describe a concrete situation. Level 0 is the first entry.",
});

const NoulParams = Type.Object({
  state: StateSchema,
  instructions: InstructionsSchema,
  criteria: Type.Optional(NoulCriteriaSchema),
});

const ChoiceParams = Type.Object({
  state: StateSchema,
  instructions: InstructionsSchema,
  criteria: ChoiceCriteriaSchema,
});

const ScoreParams = Type.Object({
  state: StateSchema,
  instructions: InstructionsSchema,
  criteria: ScoreCriteriaSchema,
});

const BatchQuestionSchema = Type.Object({
  id: Type.String({
    description:
      "Identifier for this answer in the result. It is never sent to the model and is not used for inference, so the instructions must carry the complete question.",
  }),
  type: StringEnum(["noul", "choice", "score"] as const, {
    description: "Question type: noul (yes/no probability), choice (one of a set), or score (position along ordered levels).",
  }),
  instructions: InstructionsSchema,
  criteria: Type.Optional(
    Type.Unknown({
      description:
        "Per-type criteria: noul takes {\"true\": \"...\", \"false\": \"...\"}; choice takes {\"option\": \"rubric or null\", ...}; score takes an ordered array of 2-10 level descriptions.",
    }),
  ),
});

const EvaluateParams = Type.Object({
  state: StateSchema,
  questions: Type.Array(BatchQuestionSchema, {
    minItems: 1,
    description:
      "Every question to ask about this state. They are evaluated independently and in parallel in one request, and cannot see each other's answers.",
  }),
});

export interface NoulToolDetails {
  type: "noul";
  noul: number;
  model: string;
  usage: TokenUsage;
}

export interface ChoiceToolDetails {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
  model: string;
  usage: TokenUsage;
}

export interface ScoreToolDetails {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
  model: string;
  usage: TokenUsage;
}

export interface EvaluateToolDetails {
  type: "evaluate";
  answers: SystemOneResponse["answers"];
  model: string;
  usage: TokenUsage;
}

export type TypeSafeToolDetails =
  | NoulToolDetails
  | ChoiceToolDetails
  | ScoreToolDetails
  | EvaluateToolDetails;

/** Minimal UI surface used by `/typesafe`, so tests can supply a fake. */
export interface TypeSafeCommandUi {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  confirm(title: string, message: string): Promise<boolean>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
}

export interface TypeSafeCommandContext {
  hasUI: boolean;
  ui: TypeSafeCommandUi;
}

const SETUP_REMEDY =
  "The user must run /typesafe setup in an interactive pi session; never ask for the API key in chat.";

export function createCredentialStore(agentDir: string = getAgentDir()): CredentialStore {
  return new CredentialStore({ dir: join(agentDir, TYPESAFE_CONFIG_DIR_NAME) });
}

/** Read the stored key for a tool call, failing closed with an actionable message. */
async function readApiKey(store: CredentialStore): Promise<string> {
  let stored: { apiKey: string } | undefined;
  try {
    stored = await store.read();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new TypeSafeConfigError(
      `The stored TypeSafe credentials are unusable (${reason}). ${SETUP_REMEDY}`,
    );
  }
  if (!stored) {
    throw new TypeSafeConfigError(`No TypeSafe API key is configured. ${SETUP_REMEDY}`);
  }
  return stored.apiKey;
}

/** One HTTP request per tool call; the key is read at call time so setup applies immediately. */
async function askTypeSafe(
  state: unknown,
  questions: QuestionInput[],
  signal: AbortSignal | undefined,
): Promise<SystemOneResponse> {
  const store = createCredentialStore();
  const apiKey = await readApiKey(store);
  const client = new TypeSafeClient({ apiKey });
  return await client.ask(state, questions, { signal });
}

function formatNumber(value: number): string {
  return String(Math.round(value * 10_000) / 10_000);
}

function formatDistribution(probabilities: Record<string, number>): string {
  return Object.entries(probabilities)
    .map(([label, probability]) => `${label} ${formatNumber(probability)}`)
    .join(", ");
}

function formatLegend(legend: Record<string, string>): string {
  return Object.entries(legend)
    .map(([level, description]) => `${level}: ${description}`)
    .join(" | ");
}

function answerLines(answer: Answer): string[] {
  if (answer.type === "noul") {
    return [
      `noul: ${formatNumber(answer.noul)}`,
      "noul is the probability that the answer is yes (near 1 yes, near 0 no, near 0.5 either answer is equally likely). A noul answer has no separate confidence field.",
    ];
  }
  if (answer.type === "choice") {
    return [
      `choice: ${answer.choice}`,
      `probabilities: ${formatDistribution(answer.probabilities)}`,
      `confidence: ${formatNumber(answer.confidence)} (how concentrated this distribution is, not truth or permission to act)`,
    ];
  }
  return [
    `score: ${formatNumber(answer.score)} (0-based position across the ordered criteria levels; it can land between levels)`,
    `levels: ${formatLegend(answer.legend)}`,
    `probabilities: ${formatDistribution(answer.probabilities)}`,
    `confidence: ${formatNumber(answer.confidence)} (how concentrated this distribution is, not truth or permission to act)`,
  ];
}

function usageLine(response: SystemOneResponse): string {
  return `usage: ${response.usage.input_tokens} input tokens, ${response.usage.output_tokens} output tokens (model ${response.model})`;
}

/** Keep tool output inside the pi limits and say so when it is cut. */
function boundedText(text: string): string {
  const truncated = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  if (!truncated.truncated) return text;
  return `${truncated.content}\n[Output truncated: showing ${truncated.outputLines} of ${truncated.totalLines} lines (${formatSize(truncated.outputBytes)} of ${formatSize(truncated.totalBytes)})]`;
}

export async function runTypeSafeCommand(
  args: string,
  ctx: TypeSafeCommandContext,
  store: CredentialStore,
): Promise<void> {
  const tokens = args.trim().split(/\s+/).filter((token) => token.length > 0);
  const subcommand = tokens[0]?.toLowerCase() ?? "";
  if (subcommand === "setup") {
    if (tokens.length > 1) {
      // Never read the key from a command argument: it would end up in the
      // terminal history and possibly the transcript.
      ctx.ui.notify(
        "Do not pass the API key as a /typesafe argument; it can end up in your terminal history. Enter it in the prompt instead.",
        "warning",
      );
    }
    await runSetup(ctx, store);
    return;
  }
  if (subcommand === "logout") {
    await runLogout(ctx, store);
    return;
  }
  if (subcommand === "" || subcommand === "status") {
    await runStatus(ctx, store);
    return;
  }
  ctx.ui.notify(
    `Unknown /typesafe subcommand "${subcommand}". Use /typesafe status, /typesafe setup, or /typesafe logout.`,
    "warning",
  );
}

async function runSetup(ctx: TypeSafeCommandContext, store: CredentialStore): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("TypeSafe setup needs an interactive prompt. Run /typesafe setup in the pi TUI.", "error");
    return;
  }
  const status = await store.inspect();
  if (status.configured) {
    const replace = await ctx.ui.confirm(
      "Replace the stored TypeSafe API key?",
      `A key is already stored at ${status.path}. Replacing it keeps nothing from the old key.`,
    );
    if (!replace) {
      ctx.ui.notify("TypeSafe setup cancelled; the stored key is unchanged.", "info");
      return;
    }
  } else if (status.problem) {
    const overwrite = await ctx.ui.confirm(
      "Replace the unreadable TypeSafe config?",
      `${status.problem}\nOverwrite ${status.path}?`,
    );
    if (!overwrite) {
      ctx.ui.notify("TypeSafe setup cancelled; the existing file is unchanged.", "info");
      return;
    }
  }

  const entered = await ctx.ui.input(
    "TypeSafe API key (input is not masked; characters are visible while you type)",
    "jev-...",
  );
  if (entered === undefined) {
    ctx.ui.notify("TypeSafe setup cancelled; the stored key is unchanged.", "info");
    return;
  }
  const validation = validateApiKey(entered);
  if (!validation.ok) {
    ctx.ui.notify(`No key stored: ${validation.reason}. The stored key is unchanged.`, "warning");
    return;
  }
  try {
    await store.write(validation.key, { replaceExisting: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Could not store the TypeSafe API key: ${redactSecrets(reason, validation.key)}`, "error");
    return;
  }
  ctx.ui.notify(
    `TypeSafe API key stored at ${store.file} (mode 0600 on Unix; plaintext). The key is not verified until the first typesafe_* call.`,
    "info",
  );
}

async function runStatus(ctx: TypeSafeCommandContext, store: CredentialStore): Promise<void> {
  const status = await store.inspect();
  if (status.problem) {
    ctx.ui.notify(
      `TypeSafe is not usable: ${status.problem}\nRun /typesafe setup to replace ${status.path}.`,
      "error",
    );
    return;
  }
  if (status.configured) {
    ctx.ui.notify(
      `TypeSafe: configured (model ${JEV_MODEL})\nkey file: ${status.path}\nThe key is stored in plaintext with mode 0600 and is never shown here.`,
      "info",
    );
    return;
  }
  ctx.ui.notify(
    `TypeSafe: not configured (model ${JEV_MODEL}).\nRun /typesafe setup to store an API key at ${status.path}.`,
    "warning",
  );
}

async function runLogout(ctx: TypeSafeCommandContext, store: CredentialStore): Promise<void> {
  const status = await store.inspect();
  if (!status.configured && !status.problem) {
    ctx.ui.notify("TypeSafe: no stored API key.", "info");
    return;
  }
  if (!ctx.hasUI) {
    ctx.ui.notify("TypeSafe logout needs a confirmation prompt. Run /typesafe logout in the pi TUI.", "error");
    return;
  }
  const confirmed = await ctx.ui.confirm(
    "Delete the stored TypeSafe API key?",
    `This removes ${status.path}. The typesafe_* tools stop working until /typesafe setup is run again.`,
  );
  if (!confirmed) {
    ctx.ui.notify("TypeSafe logout cancelled; the stored key is unchanged.", "info");
    return;
  }
  try {
    const removed = await store.clear();
    ctx.ui.notify(
      removed ? "Removed the stored TypeSafe API key." : "No stored TypeSafe API key to remove.",
      "info",
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Could not remove the TypeSafe API key: ${reason}`, "error");
  }
}

export default function typesafeExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "typesafe_noul",
    label: "TypeSafe Noul",
    description:
      "Ask TypeSafe/Jev a yes/no question about state and get the probability that the answer is yes. Returns 0..1 with no separate confidence. Use typesafe_score instead when the answer is a degree on a spectrum, and typesafe_choice when it is one of a known set. Requires an API key stored with /typesafe setup.",
    promptSnippet: "Probability (0..1) that a yes/no condition holds for a given state",
    promptGuidelines: [
      "Use typesafe_noul for a single yes/no judgment about state; it returns the probability that the answer is yes, not generated text.",
      "Read a typesafe_noul value near 0.5 as equal probability for yes and no, never as medium intensity; use typesafe_score for degree judgments.",
      "Ask typesafe_noul about one clearly defined condition, and define what yes and no mean in criteria when the condition is ambiguous.",
      "Batch several independent questions over the same state with typesafe_evaluate instead of calling typesafe_noul repeatedly.",
      "If typesafe_noul reports a missing or rejected API key, tell the user to run /typesafe setup; never ask for the key in chat.",
    ],
    parameters: NoulParams,
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const response = await askTypeSafe(
        params.state,
        [
          {
            id: NOUL_QUESTION_ID,
            type: "noul",
            instructions: params.instructions,
            criteria: params.criteria,
          },
        ],
        signal,
      );
      const answer = answerFor(response, NOUL_QUESTION_ID, "noul");
      return {
        content: [
          {
            type: "text" as const,
            text: boundedText(`${answerLines(answer).join("\n")}\n${usageLine(response)}`),
          },
        ],
        details: {
          type: "noul" as const,
          noul: answer.noul,
          model: response.model,
          usage: response.usage,
        } satisfies NoulToolDetails,
      };
    },
  });

  pi.registerTool({
    name: "typesafe_choice",
    label: "TypeSafe Choice",
    description:
      "Ask TypeSafe/Jev which one of a fixed set of options fits the state. Returns the chosen option, the probability of every option, and confidence. Options are unordered; add a no-match option when the list may not cover every input. Requires an API key stored with /typesafe setup.",
    promptSnippet: "Pick one option from a fixed set for a given state, with probabilities and confidence",
    promptGuidelines: [
      "Use typesafe_choice when the answer is exactly one of a known, unordered set of options you can list in full.",
      "Give typesafe_choice every option and a description that separates it from the others, and add a no-match option such as \"other\" when the list may not cover every input.",
      "Treat the confidence returned by typesafe_choice as the concentration of the probability distribution, not as truth or permission to act; keep thresholds in code.",
      "Batch several independent questions over the same state with typesafe_evaluate instead of calling typesafe_choice repeatedly.",
      "If typesafe_choice reports a missing or rejected API key, tell the user to run /typesafe setup; never ask for the key in chat.",
    ],
    parameters: ChoiceParams,
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const response = await askTypeSafe(
        params.state,
        [
          {
            id: CHOICE_QUESTION_ID,
            type: "choice",
            instructions: params.instructions,
            criteria: params.criteria,
          },
        ],
        signal,
      );
      const answer = answerFor(response, CHOICE_QUESTION_ID, "choice");
      return {
        content: [
          {
            type: "text" as const,
            text: boundedText(`${answerLines(answer).join("\n")}\n${usageLine(response)}`),
          },
        ],
        details: {
          type: "choice" as const,
          choice: answer.choice,
          probabilities: answer.probabilities,
          confidence: answer.confidence,
          model: response.model,
          usage: response.usage,
        } satisfies ChoiceToolDetails,
      };
    },
  });

  pi.registerTool({
    name: "typesafe_score",
    label: "TypeSafe Score",
    description:
      "Ask TypeSafe/Jev to rate state along ordered levels you define. Returns a probability-weighted score over the 0-based levels, the level legend, the probability of each level, and confidence. Requires an API key stored with /typesafe setup.",
    promptSnippet: "Rate a state along ordered levels, with the level distribution and confidence",
    promptGuidelines: [
      "Use typesafe_score for a degree on a spectrum, such as severity or frustration, when you can describe what each level means.",
      "Define 2 to 10 ordered, self-describing levels for typesafe_score, from the low end to the high end; a score indexes those levels starting at 0 and can land between them.",
      "Treat the confidence returned by typesafe_score as the concentration of the probability distribution, not as truth or permission to act; combine weighted scores in code.",
      "Batch several independent questions over the same state with typesafe_evaluate instead of calling typesafe_score repeatedly.",
      "If typesafe_score reports a missing or rejected API key, tell the user to run /typesafe setup; never ask for the key in chat.",
    ],
    parameters: ScoreParams,
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const response = await askTypeSafe(
        params.state,
        [
          {
            id: SCORE_QUESTION_ID,
            type: "score",
            instructions: params.instructions,
            criteria: params.criteria,
          },
        ],
        signal,
      );
      const answer = answerFor(response, SCORE_QUESTION_ID, "score");
      return {
        content: [
          {
            type: "text" as const,
            text: boundedText(`${answerLines(answer).join("\n")}\n${usageLine(response)}`),
          },
        ],
        details: {
          type: "score" as const,
          score: answer.score,
          legend: answer.legend,
          probabilities: answer.probabilities,
          confidence: answer.confidence,
          model: response.model,
          usage: response.usage,
        } satisfies ScoreToolDetails,
      };
    },
  });

  pi.registerTool({
    name: "typesafe_evaluate",
    label: "TypeSafe Evaluate",
    description:
      "Ask TypeSafe/Jev several independent typed questions about one state in a single request, mixing noul, choice, and score questions. Answers come back keyed by question id, with distributions, confidence, and token usage. Questions cannot see each other's answers. Requires an API key stored with /typesafe setup.",
    promptSnippet: "Ask several typed questions about one state in a single TypeSafe request",
    promptGuidelines: [
      "Use typesafe_evaluate whenever several independent questions share the same state, instead of asking them one at a time.",
      "Extra questions in a typesafe_evaluate call consume tokens and can add latency and cost: measure the request budget with the returned usage on your own workload before adding speculative questions.",
      "Question ids in typesafe_evaluate are for code and are never sent to the model, so put the complete question in instructions.",
      "Questions inside one typesafe_evaluate request are independent and cannot see each other's answers; make a second typesafe_evaluate call only when a question genuinely needs an earlier answer to build the next state or options.",
      "Send the same state once to typesafe_evaluate rather than repeating it across separate calls, and use the returned usage to watch request budgets.",
      "If typesafe_evaluate reports a missing or rejected API key, tell the user to run /typesafe setup; never ask for the key in chat.",
    ],
    parameters: EvaluateParams,
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const response = await askTypeSafe(
        params.state,
        params.questions.map((question) => ({
          id: question.id,
          type: question.type,
          instructions: question.instructions,
          criteria: question.criteria,
        })),
        signal,
      );
      const blocks = Object.entries(response.answers).map(([id, answer]) =>
        [`- ${id} (${answer.type}):`, ...answerLines(answer).map((line) => `  ${line}`)].join("\n"),
      );
      return {
        content: [
          {
            type: "text" as const,
            text: boundedText(
              [
                `answers (${Object.keys(response.answers).length} question(s), one request):`,
                ...blocks,
                usageLine(response),
              ].join("\n"),
            ),
          },
        ],
        details: {
          type: "evaluate" as const,
          answers: response.answers,
          model: response.model,
          usage: response.usage,
        } satisfies EvaluateToolDetails,
      };
    },
  });

  pi.registerCommand("typesafe", {
    description: "Manage the TypeSafe API key used by the typesafe_* tools (setup, status, logout)",
    getArgumentCompletions: (prefix: string) => {
      const subcommands = ["status", "setup", "logout"];
      const matches = subcommands.filter((name) => name.startsWith(prefix));
      if (matches.length === 0) return null;
      return matches.map((name) => ({
        value: name,
        label: name,
        description:
          name === "setup"
            ? "Store or replace the TypeSafe API key"
            : name === "logout"
              ? "Delete the stored TypeSafe API key"
              : "Show whether a key is stored, the model, and the key file path",
      }));
    },
    handler: async (args, ctx) => {
      await runTypeSafeCommand(args, ctx, createCredentialStore());
    },
  });
}

/**
 * TypeSafe System One HTTP client built on native fetch.
 *
 * Wire contract: https://docs.typesafe.ai/api.md (v1)
 *   POST https://api.typesafe.ai/v1/systemone
 *   Authorization: Bearer <API key>
 *   body:     { state, model: "jev-latest", questions: { [id]: Question } }
 *   response: { model, answers: { [id]: Answer }, usage: { input_tokens, output_tokens } }
 *
 * The module only uses Node built-ins at runtime so the wire behaviour can be
 * verified offline with an injected `fetch`. The API key never appears in an
 * error message: status codes and provider details are redacted before they are
 * handed back to a tool result.
 */

export const TYPESAFE_ORIGIN = "https://api.typesafe.ai";
export const TYPESAFE_SYSTEM_ONE_URL = `${TYPESAFE_ORIGIN}/v1/systemone`;
export const JEV_MODEL = "jev-latest";

export const DEFAULT_TIMEOUT_MS = 60_000;
/** Total attempts, including the first one. Only 429/529 responses are retried. */
export const DEFAULT_MAX_ATTEMPTS = 3;
export const BASE_RETRY_DELAY_MS = 500;
export const MAX_RETRY_DELAY_MS = 10_000;
export const MAX_RESPONSE_BYTES = 1_000_000;
export const MAX_ERROR_DETAIL_CHARS = 300;
export const PROBABILITY_SUM_TOLERANCE = 0.05;
export const MAX_SCORE_LEVELS = 10;
export const MAX_CHOICE_OPTIONS = 255;
export const MAX_QUESTION_ID_CHARS = 64;

export type JsonObject = { [key: string]: JsonValue };
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

/** `instructions` accepts a plain string, an object, or an array (all sent to the model as-is). */
export type QuestionInstructions = string | JsonObject | JsonValue[];

export interface NoulQuestion {
  type: "noul";
  instructions: QuestionInstructions;
  criteria?: { true?: string; false?: string };
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: QuestionInstructions;
  criteria: Record<string, string | null>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: QuestionInstructions;
  criteria: string[];
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface SystemOneResponse {
  model: string;
  answers: Record<string, Answer>;
  usage: TokenUsage;
}

/** Unvalidated question shape as it arrives from a tool parameter. */
export interface QuestionInput {
  id: string;
  type: unknown;
  instructions: unknown;
  criteria?: unknown;
}

/**
 * Base class for every error this client raises.
 *
 * These messages are shown to a language model, so an error never carries a
 * `cause` or any other attached value: everything reachable from here must
 * already be safe to display.
 */
export class TypeSafeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The stored API key is missing, unreadable, or rejected by TypeSafe. */
export class TypeSafeAuthError extends TypeSafeError {}

/** The request was rejected before or by the API as invalid (422, other 4xx). */
export class TypeSafeRequestError extends TypeSafeError {}

/** Rate limited (429) with no retry budget left. */
export class TypeSafeRateLimitError extends TypeSafeError {}

/** TypeSafe reported itself overloaded (529) with no retry budget left. */
export class TypeSafeOverloadedError extends TypeSafeError {}

/** Server-side failure that is not retried (5xx other than 529). */
export class TypeSafeServerError extends TypeSafeError {}

/** A 2xx response that does not match the documented contract, or a refused redirect. */
export class TypeSafeProtocolError extends TypeSafeError {}

/** Transport failure, including DNS/TLS errors and timeouts. */
export class TypeSafeNetworkError extends TypeSafeError {}

/** The whole request exceeded the configured timeout, including body reads and backoff. */
export class TypeSafeTimeoutError extends TypeSafeNetworkError {}

/** The caller aborted the request (pi Esc / tool cancellation). */
export class TypeSafeAbortedError extends TypeSafeError {}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type SleepLike = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface TypeSafeClientOptions {
  apiKey: string;
  /**
   * Endpoint used for the request. Defaults to the fixed production endpoint.
   * Only loopback hosts may use a non-HTTPS URL, so tests can run offline.
   */
  endpoint?: string;
  /** Transport override; defaults to the global fetch. */
  fetch?: FetchLike;
  timeoutMs?: number;
  maxAttempts?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  /** Backoff override for tests. */
  sleep?: SleepLike;
  /** Clock override for tests. */
  now?: () => number;
  /** Retry observer, used by callers that want to surface throttling progress. */
  onRetry?: (info: { attempt: number; status: number; delayMs: number }) => void;
}

export interface AskOptions {
  signal?: AbortSignal;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Guard the fixed HTTPS origin. A non-HTTPS endpoint is only accepted for
 * loopback hosts, which keeps the bearer token out of plaintext transport.
 */
export function assertEndpointAllowed(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new TypeSafeRequestError(`TypeSafe endpoint is not a valid URL: ${endpoint}`);
  }
  if (url.protocol === "https:") return url.toString();
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return url.toString();
  throw new TypeSafeRequestError(
    `Refusing to send the TypeSafe API key to ${url.origin}: only https origins are allowed`,
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function describeValue(value: unknown, maxLength = 80): string {
  let text: string;
  if (typeof value === "string") {
    text = JSON.stringify(value);
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

/**
 * Shape-only description for values that came back from the service. Unlike
 * `describeValue` this never echoes the value's text, so a response that
 * reflects a credential cannot leak it into an error message.
 */
function describeShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array with ${value.length} item(s)`;
  const kind = typeof value;
  if (kind === "string") return `string with ${(value as string).length} character(s)`;
  if (kind === "number") return `number ${Number.isFinite(value as number) ? String(value) : "(not finite)"}`;
  if (kind === "object") return `object with ${Object.keys(value as object).length} key(s)`;
  return kind;
}

function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

/**
 * Model ids are shown to the model and stored in tool details, so they must look
 * like identifiers. Identifier shape alone does not prove that the value is not
 * a credential: a key such as `jev-secret-123` is identifier-shaped, so the
 * configured key is compared separately in `modelEchoesApiKey`.
 */
const MODEL_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** Keys at least this long are matched as substrings, here and in redaction. */
export const MIN_SUBSTRING_REDACTION_LENGTH = 4;

function isModelIdentifier(value: unknown): value is string {
  return typeof value === "string" && MODEL_IDENTIFIER_PATTERN.test(value);
}

/**
 * True when a response field carries the configured API key back to us. The
 * exact form is always caught; substring matches are only checked for keys long
 * enough that a legitimate model id cannot plausibly contain them.
 */
function modelEchoesApiKey(model: string, apiKey: string): boolean {
  if (apiKey.length === 0) return false;
  if (model === apiKey) return true;
  return apiKey.length >= MIN_SUBSTRING_REDACTION_LENGTH && model.includes(apiKey);
}

/**
 * Dictionaries keyed by caller-provided names (question ids, option names, or
 * provider-returned answer keys). Entries are always written with
 * `Object.defineProperty`, so names such as `__proto__`, `constructor`, or
 * `toString` become ordinary own properties instead of hitting inherited
 * accessors, while the result stays a plain JSON-friendly object. Every lookup
 * goes through `hasOwn` for the same reason.
 */
function createDictionary<T>(): Record<string, T> {
  return {};
}

function setEntry<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** First JSON-compatibility problem found in `value`, or undefined when it is JSON-safe. */
function findJsonProblem(value: unknown, path: string, seen: Set<object>): string | undefined {
  if (value === null) return undefined;
  const kind = typeof value;
  if (kind === "string" || kind === "boolean") return undefined;
  if (kind === "number") {
    return Number.isFinite(value) ? undefined : `${path} must be a finite number`;
  }
  if (kind !== "object") {
    return `${path} must be JSON-serializable (found ${kind})`;
  }
  const object = value as object;
  if (seen.has(object)) return `${path} contains a circular reference`;
  seen.add(object);
  let problem: string | undefined;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length && !problem; index += 1) {
      problem = findJsonProblem(value[index], `${path}[${index}]`, seen);
    }
  } else if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      problem = findJsonProblem(entry, `${path}.${key}`, seen);
      if (problem) break;
    }
  } else {
    problem = `${path} must be a plain JSON object, array, string, number, boolean, or null`;
  }
  seen.delete(object);
  return problem;
}

function assertJsonValue(value: unknown, path: string): void {
  const problem = findJsonProblem(value, path, new Set<object>());
  if (problem) throw new TypeSafeRequestError(problem);
}

function normalizeInstructions(questionId: string, instructions: unknown): QuestionInstructions {
  if (typeof instructions === "string") {
    if (instructions.trim().length === 0) {
      throw new TypeSafeRequestError(
        `question "${questionId}": instructions must not be empty; write the full question to ask`,
      );
    }
    return instructions;
  }
  if (Array.isArray(instructions) || isPlainObject(instructions)) {
    if (Array.isArray(instructions) && instructions.length === 0) {
      throw new TypeSafeRequestError(`question "${questionId}": instructions array must not be empty`);
    }
    if (isPlainObject(instructions) && Object.keys(instructions).length === 0) {
      throw new TypeSafeRequestError(`question "${questionId}": instructions object must not be empty`);
    }
    assertJsonValue(instructions, `question "${questionId}".instructions`);
    return instructions as QuestionInstructions;
  }
  throw new TypeSafeRequestError(
    `question "${questionId}": instructions must be a string, object, or array (got ${describeValue(instructions)})`,
  );
}

function normalizeChoiceCriteria(
  questionId: string,
  criteria: unknown,
): Record<string, string | null> {
  if (!isPlainObject(criteria)) {
    throw new TypeSafeRequestError(
      `question "${questionId}": a choice question requires criteria as an object mapping each option to its description or null`,
    );
  }
  const entries = Object.entries(criteria);
  if (entries.length === 0) {
    throw new TypeSafeRequestError(`question "${questionId}": choice criteria must define at least one option`);
  }
  if (entries.length > MAX_CHOICE_OPTIONS) {
    throw new TypeSafeRequestError(
      `question "${questionId}": choice criteria may define at most ${MAX_CHOICE_OPTIONS} options (got ${entries.length})`,
    );
  }
  const options = createDictionary<string | null>();
  for (const [option, description] of entries) {
    if (option.trim().length === 0) {
      throw new TypeSafeRequestError(`question "${questionId}": choice option names must not be empty`);
    }
    if (description === null || typeof description === "string") {
      setEntry(options, option, description);
      continue;
    }
    throw new TypeSafeRequestError(
      `question "${questionId}": description for option "${option}" must be a string or null (got ${describeValue(description)})`,
    );
  }
  return options;
}

function normalizeScoreCriteria(questionId: string, criteria: unknown): string[] {
  if (!Array.isArray(criteria)) {
    throw new TypeSafeRequestError(
      `question "${questionId}": a score question requires criteria as an ordered array of level descriptions`,
    );
  }
  if (criteria.length < 2 || criteria.length > MAX_SCORE_LEVELS) {
    throw new TypeSafeRequestError(
      `question "${questionId}": score criteria needs 2 to ${MAX_SCORE_LEVELS} ordered levels (got ${criteria.length})`,
    );
  }
  return criteria.map((level, index) => {
    if (typeof level !== "string" || level.trim().length === 0) {
      throw new TypeSafeRequestError(
        `question "${questionId}": score level ${index} must be a non-empty description (got ${describeValue(level)})`,
      );
    }
    return level;
  });
}

function normalizeNoulCriteria(
  questionId: string,
  criteria: unknown,
): { true?: string; false?: string } | undefined {
  if (criteria === undefined || criteria === null) return undefined;
  if (!isPlainObject(criteria)) {
    throw new TypeSafeRequestError(
      `question "${questionId}": noul criteria must be an object with optional "true" and "false" descriptions`,
    );
  }
  const result: { true?: string; false?: string } = {};
  for (const [key, value] of Object.entries(criteria)) {
    if (key !== "true" && key !== "false") {
      throw new TypeSafeRequestError(
        `question "${questionId}": noul criteria only accepts "true" and "false" keys (found "${key}")`,
      );
    }
    // Only these two literal keys are accepted, so plain assignment cannot hit
    // an inherited accessor here.
    if (value === null || value === undefined) continue;
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new TypeSafeRequestError(
        `question "${questionId}": criteria.${key} must be a non-empty description (got ${describeValue(value)})`,
      );
    }
    result[key] = value;
  }
  return result.true === undefined && result.false === undefined ? undefined : result;
}

/** Validate tool input and produce the question map sent to TypeSafe. */
export function normalizeQuestions(inputs: Iterable<QuestionInput>): Record<string, Question> {
  const questions = createDictionary<Question>();
  for (const input of inputs) {
    const id = typeof input.id === "string" ? input.id.trim() : "";
    if (id.length === 0) {
      throw new TypeSafeRequestError("question id must be a non-empty string");
    }
    if (id.length > MAX_QUESTION_ID_CHARS) {
      throw new TypeSafeRequestError(
        `question id "${describeValue(id)}" is longer than ${MAX_QUESTION_ID_CHARS} characters`,
      );
    }
    if (hasOwn(questions, id)) {
      throw new TypeSafeRequestError(`duplicate question id "${id}"`);
    }
    const instructions = normalizeInstructions(id, input.instructions);
    if (input.type === "noul") {
      const criteria = normalizeNoulCriteria(id, input.criteria);
      setEntry(questions, id, criteria ? { type: "noul", instructions, criteria } : { type: "noul", instructions });
      continue;
    }
    if (input.type === "choice") {
      setEntry(questions, id, { type: "choice", instructions, criteria: normalizeChoiceCriteria(id, input.criteria) });
      continue;
    }
    if (input.type === "score") {
      setEntry(questions, id, { type: "score", instructions, criteria: normalizeScoreCriteria(id, input.criteria) });
      continue;
    }
    throw new TypeSafeRequestError(
      `question "${id}": type must be "noul", "choice", or "score" (got ${describeValue(input.type)})`,
    );
  }
  if (Object.keys(questions).length === 0) {
    throw new TypeSafeRequestError("at least one question is required");
  }
  return questions;
}

/** Build the JSON request body. Exported so tests can assert the exact wire payload. */
export function buildRequestBody(state: unknown, questions: Record<string, Question>): string {
  if (state === undefined) {
    throw new TypeSafeRequestError(
      "state is required: pass the text or structured data the questions should be judged against",
    );
  }
  if (typeof state === "string") {
    if (state.trim().length === 0) {
      throw new TypeSafeRequestError("state must not be an empty string");
    }
  } else if (Array.isArray(state) || isPlainObject(state)) {
    if (Object.keys(state).length === 0) {
      throw new TypeSafeRequestError("state must not be empty");
    }
    assertJsonValue(state, "state");
  } else {
    throw new TypeSafeRequestError(
      `state must be a string, object, or array (got ${describeValue(state)})`,
    );
  }
  return JSON.stringify({ state, model: JEV_MODEL, questions });
}

function expectFiniteNumber(value: unknown, path: string, problems: string[]): value is number {
  if (typeof value === "number" && Number.isFinite(value)) return true;
  problems.push(`${path} must be a finite number (got ${describeShape(value)})`);
  return false;
}

function expectUnitInterval(value: unknown, path: string, problems: string[]): value is number {
  if (!expectFiniteNumber(value, path, problems)) return false;
  if (value < 0 || value > 1) {
    problems.push(`${path} must be between 0 and 1 (got ${value})`);
    return false;
  }
  return true;
}

function expectProbabilityMap(
  value: unknown,
  path: string,
  expectedKeys: string[],
  problems: string[],
): Record<string, number> | undefined {
  if (!isPlainObject(value)) {
    problems.push(`${path} must be an object of probabilities (got ${describeShape(value)})`);
    return undefined;
  }
  const missing = expectedKeys.filter((key) => !hasOwn(value, key));
  const unexpectedCount = Object.keys(value).filter((key) => !expectedKeys.includes(key)).length;
  if (missing.length > 0) problems.push(`${path} is missing entries for ${describeValue(missing)}`);
  if (unexpectedCount > 0) {
    problems.push(`${path} has ${unexpectedCount} entry/entries outside the question criteria`);
  }
  const probabilities = createDictionary<number>();
  let sum = 0;
  for (const key of expectedKeys) {
    if (!hasOwn(value, key)) continue;
    const entry = value[key];
    if (!expectUnitInterval(entry, `${path}.${JSON.stringify(key)}`, problems)) continue;
    setEntry(probabilities, key, entry);
    sum += entry;
  }
  if (missing.length === 0 && Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) {
    problems.push(`${path} should sum to 1 (got ${sum.toFixed(4)})`);
  }
  return probabilities;
}

function parseAnswer(
  id: string,
  question: Question,
  raw: unknown,
  problems: string[],
): Answer | undefined {
  const path = `answers.${JSON.stringify(id)}`;
  if (!isPlainObject(raw)) {
    problems.push(`${path} must be an object (got ${describeShape(raw)})`);
    return undefined;
  }
  if (raw.type !== question.type) {
    problems.push(`${path}.type does not match the question type "${question.type}"`);
    return undefined;
  }
  if (question.type === "noul") {
    if (!expectUnitInterval(raw.noul, `${path}.noul`, problems)) return undefined;
    return { type: "noul", noul: raw.noul };
  }
  if (question.type === "choice") {
    const options = Object.keys(question.criteria);
    if (typeof raw.choice !== "string" || !options.includes(raw.choice)) {
      problems.push(
        `${path}.choice must be exactly one of the question options ${describeValue(options)}`,
      );
      return undefined;
    }
    const probabilities = expectProbabilityMap(raw.probabilities, `${path}.probabilities`, options, problems);
    if (!expectUnitInterval(raw.confidence, `${path}.confidence`, problems)) return undefined;
    if (!probabilities) return undefined;
    return { type: "choice", choice: raw.choice, probabilities, confidence: raw.confidence };
  }
  const levels = question.criteria;
  const levelKeys = levels.map((_level, index) => String(index));
  if (!expectFiniteNumber(raw.score, `${path}.score`, problems)) return undefined;
  if (raw.score < 0 || raw.score > levels.length - 1) {
    problems.push(`${path}.score must be between 0 and ${levels.length - 1}`);
    return undefined;
  }
  if (!isPlainObject(raw.legend)) {
    problems.push(`${path}.legend must be an object mapping level numbers to descriptions`);
    return undefined;
  }
  const missingLevels = levelKeys.filter((key) => !hasOwn(raw.legend as object, key));
  const unexpectedLevels = Object.keys(raw.legend).filter((key) => !levelKeys.includes(key)).length;
  if (missingLevels.length > 0) {
    problems.push(`${path}.legend is missing levels ${describeValue(missingLevels)}`);
    return undefined;
  }
  if (unexpectedLevels > 0) {
    problems.push(`${path}.legend has ${unexpectedLevels} unexpected level(s)`);
    return undefined;
  }
  // The legend is defined as the level descriptions that were sent, so the
  // returned labels are rebuilt from the request instead of echoing the
  // response text back to the model or the transcript.
  const legend = createDictionary<string>();
  for (const [index, level] of levels.entries()) {
    setEntry(legend, String(index), level);
  }
  const probabilities = expectProbabilityMap(raw.probabilities, `${path}.probabilities`, levelKeys, problems);
  if (!expectUnitInterval(raw.confidence, `${path}.confidence`, problems)) return undefined;
  if (!probabilities) return undefined;
  return { type: "score", score: raw.score, legend, probabilities, confidence: raw.confidence };
}

function parseUsage(raw: unknown, problems: string[]): TokenUsage | undefined {
  if (!isPlainObject(raw)) {
    problems.push("usage must be an object with input_tokens and output_tokens");
    return undefined;
  }
  const input = hasOwn(raw, "input_tokens") ? raw.input_tokens : undefined;
  const output = hasOwn(raw, "output_tokens") ? raw.output_tokens : undefined;
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0) {
    problems.push(`usage.input_tokens must be a non-negative number (got ${describeShape(input)})`);
    return undefined;
  }
  if (typeof output !== "number" || !Number.isFinite(output) || output < 0) {
    problems.push(`usage.output_tokens must be a non-negative number (got ${describeShape(output)})`);
    return undefined;
  }
  return { input_tokens: input, output_tokens: output };
}

/**
 * Validate a 200 response against the questions that were asked. A success
 * status with a body that does not match the contract is a protocol error: the
 * caller must never receive an invented answer.
 */
export function parseSystemOneResponse(
  bodyText: string,
  questions: Record<string, Question>,
  apiKey = "",
): SystemOneResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new TypeSafeProtocolError(
      "TypeSafe returned HTTP 200 but the body was not valid JSON",
    );
  }
  if (!isPlainObject(parsed)) {
    throw new TypeSafeProtocolError("TypeSafe returned HTTP 200 but the body was not a JSON object");
  }
  const problems: string[] = [];
  if (!isModelIdentifier(parsed.model)) {
    // The model id is shown to the model and kept in details, so it must look
    // like an identifier; a response that reflects anything else is rejected
    // without echoing the value.
    problems.push("model must be a short identifier string");
  } else if (modelEchoesApiKey(parsed.model, apiKey)) {
    // A successful response must never hand the credential back to us. The
    // value is not echoed; the caller passes its configured key.
    problems.push("model must not repeat the configured API key");
  }
  const usage = parseUsage(parsed.usage, problems);
  const answers = createDictionary<Answer>();
  if (!isPlainObject(parsed.answers)) {
    problems.push("answers must be an object keyed by question id");
  } else {
    const expectedIds = Object.keys(questions);
    const missing = expectedIds.filter((id) => !hasOwn(parsed.answers as object, id));
    const unexpectedCount = Object.keys(parsed.answers).filter((id) => !expectedIds.includes(id)).length;
    if (missing.length > 0) problems.push(`answers is missing ${describeValue(missing)}`);
    if (unexpectedCount > 0) {
      problems.push(`answers contains ${unexpectedCount} unknown question id(s)`);
    }
    for (const id of expectedIds) {
      if (!hasOwn(questions, id)) continue;
      const question = questions[id];
      if (!question) continue;
      if (!hasOwn(parsed.answers as object, id)) continue;
      const raw = parsed.answers[id];
      const answer = parseAnswer(id, question, raw, problems);
      if (answer) setEntry(answers, id, answer);
    }
  }
  if (problems.length > 0) {
    throw new TypeSafeProtocolError(
      `TypeSafe returned an unexpected response: ${problems.join("; ")}`,
    );
  }
  return {
    model: parsed.model as string,
    answers,
    usage: usage as TokenUsage,
  };
}

/** Look up an answer that must exist with the expected type (defensive; parse already enforces it). */
export function answerFor<T extends Answer["type"]>(
  response: SystemOneResponse,
  id: string,
  type: T,
): Extract<Answer, { type: T }> {
  const answer = hasOwn(response.answers, id) ? response.answers[id] : undefined;
  if (!answer) {
    throw new TypeSafeProtocolError(`TypeSafe did not return an answer for question ${JSON.stringify(id)}`);
  }
  if (answer.type !== type) {
    throw new TypeSafeProtocolError(
      `TypeSafe returned a "${answer.type}" answer for the "${type}" question ${JSON.stringify(id)}`,
    );
  }
  return answer as Extract<Answer, { type: T }>;
}

/** Escape a literal string for use inside a regular expression. */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Remove the API key and any bearer token from text before it reaches a tool
 * result. Long keys are matched as substrings; short keys are only matched as
 * standalone tokens, because replacing a one- or two-character key everywhere
 * would destroy the message without making it safer.
 */
export function redactSecrets(text: string, apiKey: string): string {
  let redacted = text;
  if (apiKey.length >= MIN_SUBSTRING_REDACTION_LENGTH) {
    redacted = redacted.split(apiKey).join("[redacted]");
  } else if (apiKey.length > 0) {
    const pattern = new RegExp(`(?<![A-Za-z0-9])${escapeForRegExp(apiKey)}(?![A-Za-z0-9])`, "g");
    redacted = redacted.replace(pattern, "[redacted]");
  }
  redacted = redacted.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{4,}/gi, "Bearer [redacted]");
  redacted = redacted.replace(
    /"(api[_-]?key|authorization)"\s*:\s*"[^"]*"/gi,
    '"$1":"[redacted]"',
  );
  return redacted;
}

function sanitizeDetail(bodyText: string, apiKey: string): string {
  let detail = bodyText.trim();
  if (detail.length > 0) {
    try {
      const parsed: unknown = JSON.parse(detail);
      if (isPlainObject(parsed)) {
        for (const key of ["detail", "message", "error", "error_message"]) {
          const value = parsed[key];
          if (typeof value === "string" && value.trim().length > 0) {
            detail = value;
            break;
          }
          if (isPlainObject(value) && typeof value.message === "string") {
            detail = value.message;
            break;
          }
        }
      }
    } catch {
      // Keep the raw text and truncate it below.
    }
  }
  detail = redactSecrets(detail, apiKey).replace(/\s+/g, " ").trim();
  if (detail.length > MAX_ERROR_DETAIL_CHARS) {
    detail = `${detail.slice(0, MAX_ERROR_DETAIL_CHARS)}...`;
  }
  return detail;
}

function parseRetryAfter(value: string | null, nowMs: number, capMs: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) return undefined;
    return Math.min(capMs, Math.round(seconds * 1000));
  }
  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) return undefined;
  return Math.min(capMs, Math.max(0, timestamp - nowMs));
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body) return await response.text();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // The connection is going away anyway.
      }
      throw new TypeSafeProtocolError(`TypeSafe response exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/** Client for the TypeSafe System One endpoint. One instance per request is fine. */
export class TypeSafeClient {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly baseRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly sleepImpl: SleepLike | undefined;
  private readonly now: () => number;
  private readonly onRetry: TypeSafeClientOptions["onRetry"];

  constructor(options: TypeSafeClientOptions) {
    if (typeof options.apiKey !== "string" || options.apiKey.trim().length === 0) {
      throw new TypeSafeAuthError("TypeSafe API key is empty");
    }
    this.apiKey = options.apiKey;
    this.endpoint = assertEndpointAllowed(options.endpoint ?? TYPESAFE_SYSTEM_ONE_URL);
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? BASE_RETRY_DELAY_MS;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? MAX_RETRY_DELAY_MS;
    this.sleepImpl = options.sleep;
    this.now = options.now ?? (() => Date.now());
    this.onRetry = options.onRetry;
  }

  /**
   * Ask one or more questions about `state`. Resolves with validated answers,
   * or throws a TypeSafeError subclass whose message is already safe to hand to
   * the model: every message leaving this method is redacted against the key.
   */
  async ask(
    state: unknown,
    questions: Iterable<QuestionInput>,
    options: AskOptions = {},
  ): Promise<SystemOneResponse> {
    const normalized = normalizeQuestions(questions);
    const requestBody = buildRequestBody(state, normalized);
    try {
      return await this.perform(requestBody, normalized, options);
    } catch (error) {
      throw this.sanitizeError(error);
    }
  }

  private async perform(
    requestBody: string,
    normalized: Record<string, Question>,
    options: AskOptions,
  ): Promise<SystemOneResponse> {
    const signal = options.signal;
    const deadline = this.now() + this.timeoutMs;
    let attempt = 1;

    for (;;) {
      this.throwIfAborted(signal);
      const remainingMs = deadline - this.now();
      if (remainingMs <= 0) {
        throw new TypeSafeTimeoutError(this.timeoutMessage());
      }
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, remainingMs);
      const forwardAbort = () => controller.abort();
      signal?.addEventListener("abort", forwardAbort, { once: true });

      let response: Response;
      let bodyText: string;
      // The same deadline covers the request, the body read, and the backoff
      // sleeps below, so a slow body cannot outlive the configured timeout.
      try {
        response = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: requestBody,
          redirect: "manual",
          signal: controller.signal,
        });
        bodyText = await readBoundedBody(response, MAX_RESPONSE_BYTES);
      } catch (error) {
        if (error instanceof TypeSafeProtocolError) throw error;
        throw this.translateTransportError(error, { timedOut, signal });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", forwardAbort);
      }
      this.throwIfAborted(signal);

      const status = response.status;
      if (status === 200) {
        return parseSystemOneResponse(bodyText, normalized, this.apiKey);
      }
      if (status > 200 && status < 300) {
        throw new TypeSafeProtocolError(
          `TypeSafe answered an unexpected success status HTTP ${status}; only 200 is expected`,
        );
      }
      if (status >= 300 && status < 400) {
        throw new TypeSafeProtocolError(
          `TypeSafe answered HTTP ${status} (redirect). Redirects are refused so the API key is never forwarded to another host.`,
        );
      }
      if (status === 401) {
        throw new TypeSafeAuthError(
          "TypeSafe rejected the stored API key (HTTP 401). Ask the user to run /typesafe setup with a valid key.",
        );
      }
      if (status >= 400 && status < 500 && status !== 429) {
        const detail = sanitizeDetail(bodyText, this.apiKey);
        throw new TypeSafeRequestError(
          `TypeSafe rejected the request (HTTP ${status})${detail ? `: ${detail}` : ""}`,
        );
      }
      if (status === 429 || status === 529) {
        const retryable = status === 429;
        if (attempt >= this.maxAttempts) {
          const detail = sanitizeDetail(bodyText, this.apiKey);
          const message = retryable
            ? `TypeSafe rate limited the request (HTTP 429) after ${attempt} attempt(s)`
            : `TypeSafe reported that it is overloaded (HTTP 529) after ${attempt} attempt(s)`;
          throw retryable
            ? new TypeSafeRateLimitError(detail ? `${message}: ${detail}` : message)
            : new TypeSafeOverloadedError(detail ? `${message}: ${detail}` : message);
        }
        const serverDelay = parseRetryAfter(response.headers.get("retry-after"), this.now(), this.maxRetryDelayMs);
        const delayMs = serverDelay ?? Math.min(this.maxRetryDelayMs, this.baseRetryDelayMs * 2 ** (attempt - 1));
        if (delayMs >= deadline - this.now()) {
          const message = retryable
            ? "TypeSafe rate limited the request (HTTP 429) and the remaining time budget is too small to retry"
            : "TypeSafe is overloaded (HTTP 529) and the remaining time budget is too small to retry";
          throw retryable ? new TypeSafeRateLimitError(message) : new TypeSafeOverloadedError(message);
        }
        this.onRetry?.({ attempt, status, delayMs });
        attempt += 1;
        await this.wait(delayMs, signal);
        continue;
      }
      const detail = sanitizeDetail(bodyText, this.apiKey);
      throw new TypeSafeServerError(
        `TypeSafe failed with HTTP ${status}${detail ? `: ${detail}` : ""}. This status is not retried automatically.`,
      );
    }
  }

  private timeoutMessage(): string {
    return `TypeSafe did not finish within ${this.timeoutMs} ms (this timeout also covers reading the response body)`;
  }

  /**
   * Last line of defence at the client boundary: whatever message is about to
   * leave this module is redacted against the API key, and no raw cause or
   * provider value is attached to the replacement error.
   */
  private sanitizeError(error: unknown): TypeSafeError {
    if (!(error instanceof TypeSafeError)) {
      const message = error instanceof Error ? error.message : String(error);
      return new TypeSafeProtocolError(redactSecrets(message, this.apiKey));
    }
    const redacted = redactSecrets(error.message, this.apiKey);
    if (redacted === error.message) return error;
    const Constructor = error.constructor as new (message: string) => TypeSafeError;
    return new Constructor(redacted);
  }

  private throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
      throw new TypeSafeAbortedError("The TypeSafe request was cancelled");
    }
  }

  private translateTransportError(
    error: unknown,
    context: { timedOut: boolean; signal: AbortSignal | undefined },
  ): TypeSafeError {
    if (context.signal?.aborted) {
      return new TypeSafeAbortedError("The TypeSafe request was cancelled");
    }
    if (context.timedOut) {
      return new TypeSafeTimeoutError(this.timeoutMessage());
    }
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return new TypeSafeNetworkError(
      `TypeSafe could not be reached (${redactSecrets(reason, this.apiKey)}). The request is not retried automatically because it may have reached the service.`,
    );
  }

  private async wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
    this.throwIfAborted(signal);
    if (this.sleepImpl) {
      await this.sleepImpl(ms, signal);
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}

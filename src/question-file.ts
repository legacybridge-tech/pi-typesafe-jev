/**
 * Question files for `typesafe_ask`.
 *
 * A question file pins one TypeSafe question (type, instructions, criteria)
 * plus a state template on disk, so the calling model only supplies the facts
 * that change between calls. The question text is never sent through the tool
 * parameters, which keeps a recurring classifier stable across calls and out of
 * the model's output budget.
 *
 * File shape (YAML or JSON):
 *
 *   type: choice
 *   instructions: |
 *     Which team should handle `ticket`?
 *   criteria:
 *     billing: Payments, invoicing, refunds
 *     other: None of the above
 *   state:
 *     ticket: { $bind: ticket }
 *     policy: "Duplicate charges are refundable."
 *
 * `state` is a template. Every `{ $bind: <name> }` node is replaced by
 * `bind[<name>]` from the tool call; every other node is copied verbatim. Only
 * `state` can be bound: `type`, `instructions`, and `criteria` are taken from
 * the file as-is, and the tool call cannot override them.
 *
 * Safety: the file is read without following a symbolic link, must be a regular
 * file under a size cap, and must not carry unknown top-level keys. Bind names
 * that the template does not use, or template slots the call does not fill,
 * are errors instead of silent omissions.
 */

import { constants as fsConstants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { TypeSafeRequestError, type Question, type QuestionInput, normalizeQuestions } from "./client.ts";

export const MAX_QUESTION_FILE_BYTES = 256 * 1024;
export const QUESTION_FILE_EXTENSIONS = new Set([".yaml", ".yml", ".json"]);
export const BIND_KEY = "$bind";
/** Keys accepted at the top level of a question file. */
export const QUESTION_FILE_KEYS = new Set(["type", "instructions", "criteria", "state", "description"]);
/** Question id used on the wire for a single-question file. */
export const ASK_QUESTION_ID = "ask";
/** Bind names must look like identifiers so they are unambiguous in error messages. */
const BIND_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const MAX_TEMPLATE_DEPTH = 32;

/** A problem with the question file itself (path, format, or content). */
export class TypeSafeQuestionFileError extends TypeSafeRequestError {}

export interface LoadedQuestionFile {
  /**
   * Display path shown to the model and stored in tool details: relative to
   * the working directory when the file lives inside it, `~/...` when it lives
   * under the home directory, otherwise just the file name. The absolute path
   * is kept out of model context and session files.
   */
  path: string;
  /** The validated question, ready for the wire. */
  question: Question;
  /** Optional free-text description from the file, for the tool's own output. */
  description?: string;
  /** Raw state template; bind slots are still `{ $bind: name }` nodes. */
  stateTemplate: unknown;
  /** Every bind name the template references, in first-seen order. */
  bindNames: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

function describeFsError(error: unknown): string {
  const code = errorCode(error);
  if (code) return code;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolve the path the model supplied. Relative paths are taken against `cwd`
 * (the same base the pi file tools use); `~` expands to the home directory.
 * The extension whitelist is checked here so an unsupported file is refused
 * before it is opened.
 */
export function resolveQuestionFilePath(input: unknown, cwd: string): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new TypeSafeQuestionFileError("questionFile must be a non-empty path to a .yaml, .yml, or .json file");
  }
  const trimmed = input.trim();
  if (trimmed.includes("\0")) {
    throw new TypeSafeQuestionFileError("questionFile must not contain a NUL character");
  }
  let candidate = trimmed;
  if (candidate === "~" || candidate.startsWith(`~${sep}`) || candidate.startsWith("~/")) {
    candidate = resolve(homedir(), candidate.slice(2));
  }
  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(cwd, candidate);
  const extension = extname(absolute).toLowerCase();
  if (!QUESTION_FILE_EXTENSIONS.has(extension)) {
    throw new TypeSafeQuestionFileError(
      `questionFile must end in .yaml, .yml, or .json (got ${JSON.stringify(trimmed)})`,
    );
  }
  return absolute;
}

/**
 * Path shown to the model and stored in the session: never the absolute path,
 * so the OS user name and directory layout stay out of model context.
 */
export function displayQuestionFilePath(absolute: string, cwd: string): string {
  const fromCwd = relative(resolve(cwd), absolute);
  if (fromCwd.length > 0 && !fromCwd.startsWith("..") && !isAbsolute(fromCwd)) return fromCwd;
  const fromHome = relative(homedir(), absolute);
  if (fromHome.length > 0 && !fromHome.startsWith("..") && !isAbsolute(fromHome)) return `~/${fromHome.split(sep).join("/")}`;
  return basename(absolute);
}

/** Read the file without following a symlink and with a size cap. */
async function readQuestionFileText(path: string, shown: string): Promise<string> {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let handle: FileHandle;
  try {
    handle = await open(path, flags);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") {
      throw new TypeSafeQuestionFileError(`question file not found: ${shown}`);
    }
    if (code === "ELOOP") {
      throw new TypeSafeQuestionFileError(`refusing to read ${shown}: it is a symbolic link`);
    }
    throw new TypeSafeQuestionFileError(`cannot read ${shown}: ${describeFsError(error)}`);
  }
  try {
    const stats = await handle.stat();
    if (stats.isSymbolicLink()) {
      throw new TypeSafeQuestionFileError(`refusing to read ${shown}: it is a symbolic link`);
    }
    if (!stats.isFile()) {
      throw new TypeSafeQuestionFileError(`refusing to read ${shown}: it is not a regular file`);
    }
    if (stats.size > MAX_QUESTION_FILE_BYTES) {
      throw new TypeSafeQuestionFileError(`${shown} is larger than ${MAX_QUESTION_FILE_BYTES} bytes`);
    }
    const text = await handle.readFile({ encoding: "utf8" });
    if (Buffer.byteLength(text, "utf8") > MAX_QUESTION_FILE_BYTES) {
      throw new TypeSafeQuestionFileError(`${shown} is larger than ${MAX_QUESTION_FILE_BYTES} bytes`);
    }
    return text;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function parseQuestionFileText(path: string, shown: string, text: string): unknown {
  const extension = extname(path).toLowerCase();
  try {
    if (extension === ".json") return JSON.parse(text);
    // Plain YAML only: no custom tags, no anchors merged into other documents.
    return parseYaml(text, { merge: false, uniqueKeys: true, maxAliasCount: 0 });
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new TypeSafeQuestionFileError(`${shown} could not be parsed: ${reason}`);
  }
}

/**
 * Walk the state template once: collect bind names and reject shapes that a
 * later fill could misinterpret (a `$bind` object with extra keys, a non-string
 * bind name, or a template deeper than the cap).
 */
function collectBindNames(node: unknown, path: string, depth: number, names: string[]): void {
  if (depth > MAX_TEMPLATE_DEPTH) {
    throw new TypeSafeQuestionFileError(`state template at ${path} is nested deeper than ${MAX_TEMPLATE_DEPTH} levels`);
  }
  if (Array.isArray(node)) {
    node.forEach((entry, index) => collectBindNames(entry, `${path}[${index}]`, depth + 1, names));
    return;
  }
  if (!isPlainObject(node)) {
    if (node !== null && typeof node === "object") {
      throw new TypeSafeQuestionFileError(`state template at ${path} must be a plain JSON value`);
    }
    return;
  }
  if (hasOwn(node, BIND_KEY)) {
    const keys = Object.keys(node);
    if (keys.length !== 1) {
      throw new TypeSafeQuestionFileError(
        `state template at ${path}: a ${BIND_KEY} node must have no other keys (found ${keys.filter((k) => k !== BIND_KEY).join(", ")})`,
      );
    }
    const name = node[BIND_KEY];
    if (typeof name !== "string" || !BIND_NAME_PATTERN.test(name)) {
      throw new TypeSafeQuestionFileError(
        `state template at ${path}: ${BIND_KEY} must be an identifier-like name (letters, digits, _ . -)`,
      );
    }
    if (!names.includes(name)) names.push(name);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    collectBindNames(value, `${path}.${key}`, depth + 1, names);
  }
}

/**
 * Load and validate a question file. The question part is normalized through
 * the same code path as the ad-hoc tools, so the wire shape is identical.
 */
export async function loadQuestionFile(input: unknown, cwd: string): Promise<LoadedQuestionFile> {
  const absolute = resolveQuestionFilePath(input, cwd);
  const path = displayQuestionFilePath(absolute, cwd);
  const text = await readQuestionFileText(absolute, path);
  const parsed = parseQuestionFileText(absolute, path, text);
  if (!isPlainObject(parsed)) {
    throw new TypeSafeQuestionFileError(`${path} must contain a single object with type, instructions, criteria, and state`);
  }
  for (const key of Object.keys(parsed)) {
    if (!QUESTION_FILE_KEYS.has(key)) {
      throw new TypeSafeQuestionFileError(
        `${path} has an unsupported top-level key "${key}" (allowed: ${[...QUESTION_FILE_KEYS].join(", ")})`,
      );
    }
  }
  if (!hasOwn(parsed, "state")) {
    throw new TypeSafeQuestionFileError(
      `${path} must define a "state" template (use { ${BIND_KEY}: name } for values supplied at call time)`,
    );
  }
  let description: string | undefined;
  if (hasOwn(parsed, "description")) {
    if (typeof parsed.description !== "string") {
      throw new TypeSafeQuestionFileError(`${path}: "description" must be a string when present`);
    }
    description = parsed.description;
  }

  const questionInput: QuestionInput = {
    id: ASK_QUESTION_ID,
    type: parsed.type,
    instructions: parsed.instructions,
    criteria: parsed.criteria,
  };
  let question: Question;
  try {
    const normalized = normalizeQuestions([questionInput]);
    const entry = normalized[ASK_QUESTION_ID];
    if (!entry) throw new TypeSafeRequestError("question missing after normalization");
    question = entry;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new TypeSafeQuestionFileError(`${path}: ${reason.replace(`question "${ASK_QUESTION_ID}": `, "")}`);
  }

  const bindNames: string[] = [];
  collectBindNames(parsed.state, "state", 0, bindNames);

  const loaded: LoadedQuestionFile = { path, question, stateTemplate: parsed.state, bindNames };
  if (description !== undefined) loaded.description = description;
  return loaded;
}

function fillTemplate(node: unknown, bind: Record<string, unknown>, used: Set<string>): unknown {
  if (Array.isArray(node)) {
    return node.map((entry) => fillTemplate(entry, bind, used));
  }
  if (!isPlainObject(node)) return node;
  if (hasOwn(node, BIND_KEY)) {
    const name = node[BIND_KEY] as string;
    used.add(name);
    return bind[name];
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    Object.defineProperty(result, key, {
      value: fillTemplate(value, bind, used),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

/**
 * Produce the concrete `state` for one call. Every template slot must be
 * supplied and every supplied bind must be used; both directions are errors so
 * a typo in a bind name cannot silently drop a fact.
 */
export function bindState(file: LoadedQuestionFile, bindInput: unknown): unknown {
  const bind: Record<string, unknown> = isPlainObject(bindInput) ? bindInput : {};
  if (bindInput !== undefined && bindInput !== null && !isPlainObject(bindInput)) {
    throw new TypeSafeQuestionFileError("bind must be an object mapping each template slot name to its value");
  }
  const supplied = Object.keys(bind);
  const missing = file.bindNames.filter((name) => !hasOwn(bind, name));
  if (missing.length > 0) {
    throw new TypeSafeQuestionFileError(
      `${file.path} needs bind value(s) for: ${missing.join(", ")}` +
        (supplied.length > 0 ? ` (supplied: ${supplied.join(", ")})` : ""),
    );
  }
  const unknown = supplied.filter((name) => !file.bindNames.includes(name));
  if (unknown.length > 0) {
    throw new TypeSafeQuestionFileError(
      `${file.path} does not use bind value(s): ${unknown.join(", ")}` +
        (file.bindNames.length > 0 ? ` (template slots: ${file.bindNames.join(", ")})` : " (template has no slots)"),
    );
  }
  for (const name of file.bindNames) {
    if (bind[name] === undefined) {
      throw new TypeSafeQuestionFileError(`bind.${name} must not be undefined`);
    }
  }
  const used = new Set<string>();
  return fillTemplate(file.stateTemplate, bind, used);
}

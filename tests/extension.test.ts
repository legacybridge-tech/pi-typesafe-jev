/**
 * Offline tests for the pi extension surface: registered tools/commands, the
 * tool execution path (with an injected fetch), and the `/typesafe` command.
 *
 * PI_CODING_AGENT_DIR points at a temporary directory for the whole file, so the
 * real user config is never read or written. No test performs network access.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { createEventBus, discoverAndLoadExtensions, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import typesafeExtension, {
  createCredentialStore,
  runTypeSafeCommand,
  type TypeSafeCommandUi,
} from "../src/index.ts";
import { CredentialStore, TypeSafeConfigError } from "../src/config.ts";

const KEY = "ts_test_key_abcdefghijklmnop";
const TOOL_NAMES = ["typesafe_choice", "typesafe_evaluate", "typesafe_noul", "typesafe_score"];

interface CapturedTool {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<{ content: { type: string; text: string }[]; details: Record<string, unknown> }>;
}

interface CapturedCommand {
  description?: string;
  getArgumentCompletions?: (prefix: string) => { value: string }[] | null;
  handler: (args: string, ctx: unknown) => Promise<void>;
}

function fakePi() {
  const tools = new Map<string, CapturedTool>();
  const commands = new Map<string, CapturedCommand>();
  const events: string[] = [];
  const providers: string[] = [];
  const pi = {
    registerTool: (tool: CapturedTool) => {
      assert.ok(!tools.has(tool.name), `duplicate tool ${tool.name}`);
      tools.set(tool.name, tool);
    },
    registerCommand: (name: string, options: CapturedCommand) => {
      commands.set(name, options);
    },
    registerProvider: (name: string) => {
      providers.push(typeof name === "string" ? name : "<provider object>");
    },
    on: (event: string) => {
      events.push(event);
    },
  };
  return { pi: pi as unknown as ExtensionAPI, tools, commands, events, providers };
}

interface FetchCall {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function stubFetch(responder: (call: FetchCall) => Response | Promise<Response>) {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const rawHeaders = init?.headers;
    const headers: Record<string, string> =
      rawHeaders instanceof Headers
        ? Object.fromEntries(rawHeaders.entries())
        : Array.isArray(rawHeaders)
          ? Object.fromEntries(rawHeaders as [string, string][])
          : { ...((rawHeaders as Record<string, string> | undefined) ?? {}) };
    const call: FetchCall = {
      url,
      headers,
      body: JSON.parse(typeof init?.body === "string" ? init.body : "{}"),
    };
    calls.push(call);
    return await responder(call);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let agentDir = "";

before(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "pi-typesafe-extension-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

after(async () => {
  delete process.env.PI_CODING_AGENT_DIR;
  await rm(agentDir, { recursive: true, force: true });
});

async function freshAgentDir(): Promise<string> {
  return await mkdtemp(join(agentDir, "case-"));
}

/** Install a key where the extension itself looks for it (the isolated agent dir). */
async function installKey(key = KEY): Promise<CredentialStore> {
  const store = createCredentialStore();
  await store.write(key, { replaceExisting: true });
  return store;
}

async function removeKey(): Promise<void> {
  try {
    await createCredentialStore().clear();
  } catch {
    // Nothing to remove.
  }
}

/** A store in its own temp directory, for tests that pass the store explicitly. */
async function newStoreWithKey(key = KEY): Promise<CredentialStore> {
  const store = createCredentialStore(await freshAgentDir());
  await store.write(key);
  return store;
}

async function corrupt(store: CredentialStore, content = "{ not json"): Promise<void> {
  await mkdir(store.dir, { recursive: true });
  await writeFile(store.file, content, "utf8");
}

interface UiLog {
  notifications: { message: string; type?: string }[];
  confirmations: { title: string; message: string }[];
  prompts: string[];
  ui: TypeSafeCommandUi;
}

function fakeUi(options: {
  confirm?: boolean | ((title: string) => boolean);
  input?: string | undefined;
}): UiLog {
  const notifications: UiLog["notifications"] = [];
  const confirmations: UiLog["confirmations"] = [];
  const prompts: string[] = [];
  const ui: TypeSafeCommandUi = {
    notify: (message, type) => {
      notifications.push({ message, type });
    },
    confirm: async (title, message) => {
      confirmations.push({ title, message });
      return typeof options.confirm === "function" ? options.confirm(title) : (options.confirm ?? false);
    },
    input: async (title) => {
      prompts.push(title);
      return options.input;
    },
  };
  return { notifications, confirmations, prompts, ui };
}

describe("extension wiring", () => {
  it("registers exactly the four TypeSafe tools and the command, and starts nothing", () => {
    const { pi, tools, commands, events, providers } = fakePi();
    typesafeExtension(pi);
    assert.deepEqual([...tools.keys()].sort(), TOOL_NAMES);
    assert.deepEqual([...commands.keys()], ["typesafe"]);
    assert.deepEqual(events, [], "the factory must not subscribe to lifecycle events");
    assert.deepEqual(providers, [], "Jev is a tool service, not a chat model provider");
  });

  it("gives every tool a snippet, guidelines that name a tool, and setup instructions", () => {
    const { pi, tools } = fakePi();
    typesafeExtension(pi);
    for (const tool of tools.values()) {
      assert.ok(tool.label.length > 0, `${tool.name} needs a label`);
      assert.ok(tool.promptSnippet && tool.promptSnippet.length > 0, `${tool.name} needs a promptSnippet`);
      assert.match(tool.description, /\/typesafe setup/, `${tool.name} description must explain setup`);
      const guidelines = tool.promptGuidelines ?? [];
      assert.ok(guidelines.length > 0, `${tool.name} needs promptGuidelines`);
      for (const guideline of guidelines) {
        assert.match(guideline, /typesafe_/, `${tool.name} guideline must name its tool: ${guideline}`);
      }
    }
  });

  it("offers /typesafe argument completions", () => {
    const { pi, commands } = fakePi();
    typesafeExtension(pi);
    const command = commands.get("typesafe");
    assert.ok(command?.getArgumentCompletions);
    assert.deepEqual(
      command.getArgumentCompletions("")?.map((item) => item.value),
      ["status", "setup", "logout"],
    );
    assert.deepEqual(command.getArgumentCompletions("set")?.map((item) => item.value), ["setup"]);
    assert.equal(command.getArgumentCompletions("nope"), null);
  });

  it("tells the model to measure request cost instead of claiming extra questions are free", () => {
    const { pi, tools } = fakePi();
    typesafeExtension(pi);
    const guidelines = (tools.get("typesafe_evaluate")?.promptGuidelines ?? []).join("\n");
    assert.ok(!/barely change latency/i.test(guidelines), "no categorical latency claim");
    assert.match(guidelines, /consume tokens/);
    assert.match(guidelines, /measure/);
  });

  it("loads through the real pi extension loader without errors and without contacting anything", async () => {
    const projectRoot = fileURLToPath(new URL("..", import.meta.url));
    const extensionPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));

    // 1. Loaded as a package directory, which must go through the "pi" manifest.
    const asPackage = await discoverAndLoadExtensions([projectRoot], await freshAgentDir(), agentDir, createEventBus());
    assert.deepEqual(asPackage.errors, []);
    assert.equal(asPackage.extensions.length, 1, "the pi manifest must resolve to exactly one entry point");

    // 2. Loaded as a single file, the shape `pi -e ./src/index.ts` uses.
    const asFile = await discoverAndLoadExtensions([extensionPath], await freshAgentDir(), agentDir, createEventBus());
    assert.deepEqual(asFile.errors, []);

    for (const result of [asPackage, asFile]) {
      const extension = result.extensions[0];
      assert.ok(extension);
      assert.deepEqual([...extension.tools.keys()].sort(), TOOL_NAMES);
      assert.ok(extension.commands.has("typesafe"));
      for (const tool of extension.tools.values()) {
        const definition = tool.definition;
        assert.equal(typeof definition.execute, "function");
        assert.ok(definition.label.length > 0);
        const schema = JSON.parse(JSON.stringify(definition.parameters)) as {
          type?: string;
          required?: string[];
        };
        assert.equal(schema.type, "object", `${definition.name} must expose an object schema`);
        assert.ok(Array.isArray(schema.required), `${definition.name} must declare required fields`);
        assert.ok(schema.required.includes("state"), `${definition.name} must require state`);
      }
    }
  });
});

describe("tool execution", () => {
  it("refuses to guess a path outside the isolated agent dir", async () => {
    assert.ok(
      createCredentialStore().file.startsWith(agentDir),
      "tests must never resolve the real user config directory",
    );
  });

  it("asks a noul question and returns the probability, distribution and usage", async () => {
    const store = await installKey();
    assert.ok(store.file.startsWith(agentDir));
    const { pi, tools } = fakePi();
    typesafeExtension(pi);
    const fetchStub = stubFetch(() =>
      jsonResponse({
        model: "jev-latest",
        answers: { noul: { type: "noul", noul: 0.92 } },
        usage: { input_tokens: 312, output_tokens: 48 },
      }),
    );
    try {
      const tool = tools.get("typesafe_noul");
      assert.ok(tool);
      const result = await tool.execute(
        "call-1",
        { state: "Help! My payouts have been failing.", instructions: "Does this convey urgency?" },
        undefined,
        undefined,
        undefined,
      );
      assert.equal(fetchStub.calls.length, 1);
      const call = fetchStub.calls[0];
      assert.ok(call);
      assert.equal(call.url, "https://api.typesafe.ai/v1/systemone");
      assert.equal(call.headers.authorization, `Bearer ${KEY}`);
      assert.equal(call.body.model, "jev-latest");
      assert.deepEqual(call.body.questions, {
        noul: { type: "noul", instructions: "Does this convey urgency?" },
      });
      assert.equal(result.content.length, 1);
      const text = result.content[0]?.text ?? "";
      assert.match(text, /noul: 0\.92/);
      assert.match(text, /no separate confidence field/);
      assert.match(text, /312 input tokens/);
      assert.deepEqual(result.details, {
        type: "noul",
        noul: 0.92,
        model: "jev-latest",
        usage: { input_tokens: 312, output_tokens: 48 },
      });
    } finally {
      fetchStub.restore();
    }
  });

  it("asks a choice question and preserves the distribution and confidence", async () => {
    await installKey();
    const { pi, tools } = fakePi();
    typesafeExtension(pi);
    const fetchStub = stubFetch(() =>
      jsonResponse({
        model: "jev-latest",
        answers: {
          choice: {
            type: "choice",
            choice: "technical",
            probabilities: { billing: 0.08, technical: 0.85, other: 0.07 },
            confidence: 0.82,
          },
        },
        usage: { input_tokens: 400, output_tokens: 20 },
      }),
    );
    try {
      const tool = tools.get("typesafe_choice");
      assert.ok(tool);
      const result = await tool.execute(
        "call-2",
        {
          state: { ticket: "500 errors on every request" },
          instructions: "Which team should handle this?",
          criteria: { billing: "payments", technical: "bugs", other: "none of the above" },
        },
        undefined,
        undefined,
        undefined,
      );
      assert.deepEqual(result.details, {
        type: "choice",
        choice: "technical",
        probabilities: { billing: 0.08, technical: 0.85, other: 0.07 },
        confidence: 0.82,
        model: "jev-latest",
        usage: { input_tokens: 400, output_tokens: 20 },
      });
      const text = result.content[0]?.text ?? "";
      assert.match(text, /choice: technical/);
      assert.match(text, /billing 0\.08, technical 0\.85, other 0\.07/);
      assert.match(text, /confidence: 0\.82/);
    } finally {
      fetchStub.restore();
    }
  });

  it("asks a score question and keeps the 0-based legend", async () => {
    await installKey();
    const { pi, tools } = fakePi();
    typesafeExtension(pi);
    const fetchStub = stubFetch(() =>
      jsonResponse({
        model: "jev-latest",
        answers: {
          score: {
            type: "score",
            score: 1.6,
            legend: { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
            probabilities: { "0": 0.05, "1": 0.3, "2": 0.65 },
            confidence: 0.78,
          },
        },
        usage: { input_tokens: 100, output_tokens: 10 },
      }),
    );
    try {
      const tool = tools.get("typesafe_score");
      assert.ok(tool);
      const result = await tool.execute(
        "call-3",
        {
          state: "This is the third time I have asked.",
          instructions: "How frustrated is the customer?",
          criteria: ["Calm", "Frustrated", "Very angry"],
        },
        undefined,
        undefined,
        undefined,
      );
      assert.deepEqual(result.details, {
        type: "score",
        score: 1.6,
        legend: { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
        probabilities: { "0": 0.05, "1": 0.3, "2": 0.65 },
        confidence: 0.78,
        model: "jev-latest",
        usage: { input_tokens: 100, output_tokens: 10 },
      });
      const text = result.content[0]?.text ?? "";
      assert.match(text, /score: 1\.6/);
      assert.match(text, /0: Calm \| 1: Frustrated \| 2: Very angry/);
    } finally {
      fetchStub.restore();
    }
  });

  it("sends a mixed batch as one request and reports each answer", async () => {
    await installKey();
    const { pi, tools } = fakePi();
    typesafeExtension(pi);
    const fetchStub = stubFetch(() =>
      jsonResponse({
        model: "jev-latest",
        answers: {
          is_urgent: { type: "noul", noul: 0.9 },
          department: {
            type: "choice",
            choice: "technical",
            probabilities: { billing: 0.1, technical: 0.9 },
            confidence: 0.8,
          },
          frustration: {
            type: "score",
            score: 2,
            legend: { "0": "Calm", "1": "Concerned", "2": "Angry" },
            probabilities: { "0": 0, "1": 0.05, "2": 0.95 },
            confidence: 0.9,
          },
        },
        usage: { input_tokens: 900, output_tokens: 60 },
      }),
    );
    try {
      const tool = tools.get("typesafe_evaluate");
      assert.ok(tool);
      const result = await tool.execute(
        "call-4",
        {
          state: "ticket text",
          questions: [
            { id: "is_urgent", type: "noul", instructions: "Is it urgent?" },
            { id: "department", type: "choice", instructions: "Which team?", criteria: { billing: null, technical: null } },
            { id: "frustration", type: "score", instructions: "How frustrated?", criteria: ["Calm", "Concerned", "Angry"] },
          ],
        },
        undefined,
        undefined,
        undefined,
      );
      assert.equal(fetchStub.calls.length, 1, "a batch must be a single HTTP request");
      assert.deepEqual(Object.keys(fetchStub.calls[0]?.body.questions ?? {}), [
        "is_urgent",
        "department",
        "frustration",
      ]);
      const text = result.content[0]?.text ?? "";
      assert.match(text, /- is_urgent \(noul\):/);
      assert.match(text, /- department \(choice\):/);
      assert.match(text, /- frustration \(score\):/);
      assert.match(text, /3 question\(s\), one request/);
      assert.deepEqual(Object.keys((result.details as { answers: object }).answers), [
        "is_urgent",
        "department",
        "frustration",
      ]);
    } finally {
      fetchStub.restore();
    }
  });

  it("rejects invalid question input before any request is sent", async () => {
    await installKey();
    const { pi, tools } = fakePi();
    typesafeExtension(pi);
    const fetchStub = stubFetch(() => jsonResponse({}));
    try {
      const tool = tools.get("typesafe_score");
      assert.ok(tool);
      await assert.rejects(
        () =>
          tool.execute(
            "call-5",
            { state: "text", instructions: "How bad?", criteria: ["only one level"] },
            undefined,
            undefined,
            undefined,
          ),
        /score criteria needs 2 to 10/,
      );
      assert.equal(fetchStub.calls.length, 0);
    } finally {
      fetchStub.restore();
    }
  });

  it("asks the human to run /typesafe setup when no key is stored", async () => {
    await removeKey();
    const store = createCredentialStore();
    assert.equal(await store.read(), undefined);
    const { pi, tools } = fakePi();
    typesafeExtension(pi);
    const fetchStub = stubFetch(() => jsonResponse({}));
    try {
      const tool = tools.get("typesafe_noul");
      assert.ok(tool);
      await assert.rejects(
        () =>
          tool.execute("call-6", { state: "s", instructions: "i" }, undefined, undefined, undefined),
        (error: unknown) => {
          assert.ok(error instanceof TypeSafeConfigError);
          assert.match(error.message, /\/typesafe setup/);
          return true;
        },
      );
      assert.equal(fetchStub.calls.length, 0, "a missing key must not trigger a request");
    } finally {
      fetchStub.restore();
    }
  });

  it("refuses a model id that echoes an identifier-shaped key, through the tool", async () => {
    const identifierShapedKey = "jev-secret-123";
    await installKey(identifierShapedKey);
    const { pi, tools } = fakePi();
    typesafeExtension(pi);
    const fetchStub = stubFetch(() =>
      jsonResponse({
        model: identifierShapedKey,
        answers: { noul: { type: "noul", noul: 0.5 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    try {
      const tool = tools.get("typesafe_noul");
      assert.ok(tool);
      await assert.rejects(
        () => tool.execute("call-echo", { state: "s", instructions: "i" }, undefined, undefined, undefined),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok(!error.message.includes(identifierShapedKey), `key leaked: ${error.message}`);
          assert.match(error.message, /must not repeat the configured API key/);
          return true;
        },
      );
      assert.equal(fetchStub.calls.length, 1, "the request itself was still sent");
    } finally {
      fetchStub.restore();
      await installKey();
    }
  });

  it("returns the real model id in details on the normal path", async () => {
    await installKey();
    const { pi, tools } = fakePi();
    typesafeExtension(pi);
    const fetchStub = stubFetch(() =>
      jsonResponse({
        model: "jev-latest",
        answers: { noul: { type: "noul", noul: 0.1 } },
        usage: { input_tokens: 2, output_tokens: 1 },
      }),
    );
    try {
      const tool = tools.get("typesafe_noul");
      assert.ok(tool);
      const result = await tool.execute("call-model", { state: "s", instructions: "i" }, undefined, undefined, undefined);
      assert.equal((result.details as { model: string }).model, "jev-latest");
      assert.match(result.content[0]?.text ?? "", /model jev-latest/);
    } finally {
      fetchStub.restore();
    }
  });

  it("never repeats malformed config values in tool errors or status output", async () => {
    const store = createCredentialStore();
    await mkdir(store.dir, { recursive: true });
    await writeFile(store.file, JSON.stringify({ version: KEY, apiKey: KEY }), "utf8");
    const { pi, tools } = fakePi();
    typesafeExtension(pi);
    const fetchStub = stubFetch(() => jsonResponse({}));
    try {
      const tool = tools.get("typesafe_noul");
      assert.ok(tool);
      await assert.rejects(
        () => tool.execute("call-leak", { state: "s", instructions: "i" }, undefined, undefined, undefined),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok(!error.message.includes(KEY), `tool error leaked a config value: ${error.message}`);
          return true;
        },
      );
      assert.equal(fetchStub.calls.length, 0);

      const ui = fakeUi({});
      const statusStore = createCredentialStore(await freshAgentDir());
      await mkdir(statusStore.dir, { recursive: true });
      await writeFile(statusStore.file, JSON.stringify({ version: KEY, apiKey: KEY }), "utf8");
      await runTypeSafeCommand("status", { hasUI: true, ui: ui.ui }, statusStore);
      assert.ok(!(ui.notifications[0]?.message ?? "").includes(KEY), "status leaked a config value");
      assert.equal(ui.notifications[0]?.type, "error");
    } finally {
      fetchStub.restore();
      await removeKey();
    }
  });

  it("handles prototype-colliding question ids and option names end to end", async () => {
    await installKey();
    const { pi, tools } = fakePi();
    typesafeExtension(pi);
    const fetchStub = stubFetch((call) => {
      assert.deepEqual(Object.keys(call.body.questions as object).sort(), ["__proto__", "constructor"]);
      const questions = call.body.questions as Record<string, { criteria?: Record<string, unknown> }>;
      assert.deepEqual(Object.keys(questions["constructor"]?.criteria ?? {}).sort(), ["__proto__", "toString"]);
      return jsonResponse(
        JSON.parse(
          '{"model":"jev-latest","answers":{"__proto__":{"type":"noul","noul":0.4},"constructor":{"type":"choice","choice":"__proto__","probabilities":{"__proto__":0.6,"toString":0.4},"confidence":0.2}},"usage":{"input_tokens":7,"output_tokens":3}}',
        ),
      );
    });
    try {
      const tool = tools.get("typesafe_evaluate");
      assert.ok(tool);
      const result = await tool.execute(
        "call-proto",
        {
          state: "state",
          questions: [
            { id: "__proto__", type: "noul", instructions: "Is it true?" },
            {
              id: "constructor",
              type: "choice",
              instructions: "Which one?",
              criteria: JSON.parse('{"__proto__": null, "toString": null}') as Record<string, null>,
            },
          ],
        },
        undefined,
        undefined,
        undefined,
      );
      const answers = (result.details as { answers: Record<string, unknown> }).answers;
      assert.deepEqual(Object.keys(answers).sort(), ["__proto__", "constructor"]);
      assert.deepEqual(answers["__proto__"], { type: "noul", noul: 0.4 });
      const text = result.content[0]?.text ?? "";
      assert.match(text, /- __proto__ \(noul\):/);
      assert.match(text, /- constructor \(choice\):/);
    } finally {
      fetchStub.restore();
    }
  });

  it("tells the model to send the user to setup when the stored file is unusable", async () => {
    const store = createCredentialStore();
    await corrupt(store);
    const { pi, tools } = fakePi();
    typesafeExtension(pi);
    const fetchStub = stubFetch(() => jsonResponse({}));
    try {
      const tool = tools.get("typesafe_choice");
      assert.ok(tool);
      await assert.rejects(
        () =>
          tool.execute(
            "call-7",
            { state: "s", instructions: "i", criteria: { a: null } },
            undefined,
            undefined,
            undefined,
          ),
        (error: unknown) => {
          assert.ok(error instanceof TypeSafeConfigError);
          assert.match(error.message, /unusable/);
          assert.match(error.message, /\/typesafe setup/);
          return true;
        },
      );
    } finally {
      fetchStub.restore();
    }
  });

  it("never puts the key into tool output or error messages", async () => {
    await installKey();    const { pi, tools } = fakePi();
    typesafeExtension(pi);
    const tool = tools.get("typesafe_noul");
    assert.ok(tool);

    const ok = stubFetch(() =>
      jsonResponse({
        model: "jev-latest",
        answers: { noul: { type: "noul", noul: 0.5 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    try {
      const result = await tool.execute("call-8", { state: "s", instructions: "i" }, undefined, undefined, undefined);
      const serialized = `${result.content[0]?.text ?? ""}${JSON.stringify(result.details)}`;
      assert.ok(!serialized.includes(KEY));
    } finally {
      ok.restore();
    }

    const failing = stubFetch(() => jsonResponse({ detail: `rejected key ${KEY}` }, 422));
    try {
      await assert.rejects(
        () => tool.execute("call-9", { state: "s", instructions: "i" }, undefined, undefined, undefined),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok(!error.message.includes(KEY), "the key must be redacted from provider errors");
          assert.match(error.message, /\[redacted\]/);
          return true;
        },
      );
    } finally {
      failing.restore();
    }
  });
});

describe("/typesafe command", () => {
  it("defaults to status and reports a missing key", async () => {
    const store = createCredentialStore(await freshAgentDir());
    const ui = fakeUi({});
    await runTypeSafeCommand("", { hasUI: true, ui: ui.ui }, store);
    assert.equal(ui.notifications.length, 1);
    assert.match(ui.notifications[0]?.message ?? "", /not configured/);
    assert.match(ui.notifications[0]?.message ?? "", /\/typesafe setup/);
    assert.equal(ui.notifications[0]?.type, "warning");
  });

  it("reports a stored key without ever showing it", async () => {
    const store = await newStoreWithKey();
    const ui = fakeUi({});
    await runTypeSafeCommand("status", { hasUI: true, ui: ui.ui }, store);
    const message = ui.notifications[0]?.message ?? "";
    assert.match(message, /configured/);
    assert.match(message, /model jev-latest/);
    assert.ok(message.includes(store.file));
    assert.ok(!message.includes(KEY));
  });

  it("reports an unusable config file", async () => {
    const store = createCredentialStore(await freshAgentDir());
    await corrupt(store);
    const ui = fakeUi({});
    await runTypeSafeCommand("status", { hasUI: true, ui: ui.ui }, store);
    assert.equal(ui.notifications[0]?.type, "error");
    assert.match(ui.notifications[0]?.message ?? "", /not valid JSON/);
  });

  it("stores a key through the masked-input-less prompt and discloses that limitation", async () => {
    const store = createCredentialStore(await freshAgentDir());
    const ui = fakeUi({ input: KEY });
    await runTypeSafeCommand("setup", { hasUI: true, ui: ui.ui }, store);
    assert.deepEqual(await store.read(), { version: 1, apiKey: KEY });
    assert.equal(ui.prompts.length, 1);
    assert.match(ui.prompts[0] ?? "", /not masked/);
    const message = ui.notifications[0]?.message ?? "";
    assert.ok(message.includes(store.file));
    assert.ok(!message.includes(KEY));
    assert.match(message, /plaintext/);
    assert.equal(await readFile(store.file, "utf8").then((text) => text.includes(KEY)), true);
  });

  it("keeps the previous key when setup is cancelled or the input is empty", async () => {
    const store = await newStoreWithKey();
    const cancelled = fakeUi({ confirm: true, input: undefined });
    await runTypeSafeCommand("setup", { hasUI: true, ui: cancelled.ui }, store);
    assert.equal((await store.read())?.apiKey, KEY);
    assert.match(cancelled.notifications[0]?.message ?? "", /cancelled/);

    const empty = fakeUi({ confirm: true, input: "   " });
    await runTypeSafeCommand("setup", { hasUI: true, ui: empty.ui }, store);
    assert.equal((await store.read())?.apiKey, KEY);
    assert.match(empty.notifications[0]?.message ?? "", /empty/);
  });

  it("keeps the previous key when the replacement is declined", async () => {
    const store = await newStoreWithKey();
    const ui = fakeUi({ confirm: false, input: "ts_new_key_zzzzzzzzzzzz" });
    await runTypeSafeCommand("setup", { hasUI: true, ui: ui.ui }, store);
    assert.equal((await store.read())?.apiKey, KEY);
    assert.equal(ui.prompts.length, 0, "no key prompt when replacement is declined");
  });

  it("replaces the key after confirmation", async () => {
    const store = await newStoreWithKey();
    const ui = fakeUi({ confirm: true, input: "  ts_new_key_zzzzzzzzzzzz  " });
    await runTypeSafeCommand("setup", { hasUI: true, ui: ui.ui }, store);
    assert.equal((await store.read())?.apiKey, "ts_new_key_zzzzzzzzzzzz");
  });

  it("asks before overwriting an unreadable file and preserves it when declined", async () => {
    const store = createCredentialStore(await freshAgentDir());
    await corrupt(store);

    const declined = fakeUi({ confirm: false, input: KEY });
    await runTypeSafeCommand("setup", { hasUI: true, ui: declined.ui }, store);
    assert.equal(await readFile(store.file, "utf8"), "{ not json");
    assert.match(declined.confirmations[0]?.message ?? "", /not valid JSON/);

    const accepted = fakeUi({ confirm: true, input: KEY });
    await runTypeSafeCommand("setup", { hasUI: true, ui: accepted.ui }, store);
    assert.equal((await store.read())?.apiKey, KEY);
  });

  it("requires interactive UI for setup and logout", async () => {
    const store = createCredentialStore(await freshAgentDir());
    const noUi = fakeUi({ input: KEY });
    await runTypeSafeCommand("setup", { hasUI: false, ui: noUi.ui }, store);
    assert.equal(await store.read(), undefined);
    assert.equal(noUi.notifications[0]?.type, "error");

    await store.write(KEY);
    const logoutNoUi = fakeUi({});
    await runTypeSafeCommand("logout", { hasUI: false, ui: logoutNoUi.ui }, store);
    assert.equal((await store.read())?.apiKey, KEY);
    assert.equal(logoutNoUi.notifications[0]?.type, "error");
  });

  it("deletes the key only after confirmation", async () => {
    const store = await newStoreWithKey();
    const declined = fakeUi({ confirm: false });
    await runTypeSafeCommand("logout", { hasUI: true, ui: declined.ui }, store);
    assert.equal((await store.read())?.apiKey, KEY);

    const accepted = fakeUi({ confirm: true });
    await runTypeSafeCommand("logout", { hasUI: true, ui: accepted.ui }, store);
    assert.equal(await store.read(), undefined);
    assert.match(accepted.notifications[0]?.message ?? "", /Removed/);
  });

  it("reports when there is nothing to log out, and rejects unknown subcommands", async () => {
    const store = createCredentialStore(await freshAgentDir());
    const logout = fakeUi({});
    await runTypeSafeCommand("logout", { hasUI: true, ui: logout.ui }, store);
    assert.match(logout.notifications[0]?.message ?? "", /no stored API key/i);

    const unknown = fakeUi({});
    await runTypeSafeCommand("frobnicate", { hasUI: true, ui: unknown.ui }, store);
    assert.equal(unknown.notifications[0]?.type, "warning");
    assert.match(unknown.notifications[0]?.message ?? "", /Unknown \/typesafe subcommand/);
  });

  it("warns when a key is passed as a command argument instead of the prompt", async () => {
    const store = createCredentialStore(await freshAgentDir());
    const ui = fakeUi({ input: KEY });
    await runTypeSafeCommand(`setup ${KEY}`, { hasUI: true, ui: ui.ui }, store);
    assert.equal(ui.notifications[0]?.type, "warning");
    assert.match(ui.notifications[0]?.message ?? "", /terminal history/);
    assert.ok(!(ui.notifications[0]?.message ?? "").includes(KEY), "the argument must not be echoed");
    assert.equal((await store.read())?.apiKey, KEY, "the prompted key is still stored");
  });

  it("accepts a subcommand with surrounding whitespace", async () => {
    const store = await newStoreWithKey();
    const ui = fakeUi({});
    await runTypeSafeCommand("  status  ", { hasUI: true, ui: ui.ui }, store);
    assert.match(ui.notifications[0]?.message ?? "", /configured/);
  });
});

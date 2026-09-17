/**
 * Offline wire/behaviour tests for src/client.ts.
 *
 * Every test injects `fetch`, a clock, and `sleep`, so nothing here touches the
 * network and no real credential is ever used.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  JEV_MODEL,
  MAX_RESPONSE_BYTES,
  TYPESAFE_SYSTEM_ONE_URL,
  TypeSafeAbortedError,
  TypeSafeAuthError,
  TypeSafeClient,
  TypeSafeNetworkError,
  TypeSafeOverloadedError,
  TypeSafeProtocolError,
  TypeSafeRateLimitError,
  TypeSafeRequestError,
  TypeSafeServerError,
  TypeSafeTimeoutError,
  answerFor,
  assertEndpointAllowed,
  buildRequestBody,
  normalizeQuestions,
  parseSystemOneResponse,
  redactSecrets,
} from "../src/client.ts";

const TEST_KEY = "test-key-not-a-real-credential";

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
  headers: Record<string, string>;
  body: string | undefined;
}

function headerRecord(headers: RequestInit["headers"]): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers as [string, string][]);
  }
  return { ...(headers as Record<string, string>) };
}

function recordingFetch(responder: (call: FetchCall, index: number) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const call: FetchCall = {
      url,
      init,
      headers: headerRecord(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    return await responder(call, calls.length - 1);
  };
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function noulBody(id = "noul", value = 0.92) {
  return {
    model: JEV_MODEL,
    answers: { [id]: { type: "noul", noul: value } },
    usage: { input_tokens: 312, output_tokens: 48 },
  };
}

function clientWith(
  fetchImpl: ReturnType<typeof recordingFetch>["fetchImpl"],
  overrides: Partial<ConstructorParameters<typeof TypeSafeClient>[0]> = {},
): TypeSafeClient {
  return new TypeSafeClient({ apiKey: TEST_KEY, fetch: fetchImpl, ...overrides });
}

describe("endpoint policy", () => {
  it("defaults to the fixed production URL", () => {
    assert.equal(TYPESAFE_SYSTEM_ONE_URL, "https://api.typesafe.ai/v1/systemone");
    assert.equal(assertEndpointAllowed(TYPESAFE_SYSTEM_ONE_URL), TYPESAFE_SYSTEM_ONE_URL);
  });

  it("accepts http only for loopback hosts", () => {
    assert.equal(assertEndpointAllowed("http://127.0.0.1:9/v1/systemone"), "http://127.0.0.1:9/v1/systemone");
    assert.throws(() => assertEndpointAllowed("http://api.typesafe.ai/v1/systemone"), TypeSafeRequestError);
    assert.throws(() => assertEndpointAllowed("not a url"), TypeSafeRequestError);
  });
});

describe("request construction", () => {
  it("posts to the documented URL with bearer auth and the documented body", async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(noulBody("is_urgent")));
    const client = clientWith(fetchImpl);
    await client.ask("Is this urgent?", [
      { id: "is_urgent", type: "noul", instructions: "Does this convey urgency?" },
    ]);

    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.ok(call);
    assert.equal(call.url, TYPESAFE_SYSTEM_ONE_URL);
    assert.equal(call.init?.method, "POST");
    assert.equal(call.headers.authorization, `Bearer ${TEST_KEY}`);
    assert.equal(call.headers["content-type"], "application/json");
    assert.equal(call.init?.redirect, "manual", "redirects must never be followed with a bearer token");
    assert.ok(call.init?.signal instanceof AbortSignal, "requests must be abortable");
    assert.deepEqual(JSON.parse(call.body ?? "{}"), {
      state: "Is this urgent?",
      model: JEV_MODEL,
      questions: {
        is_urgent: { type: "noul", instructions: "Does this convey urgency?" },
      },
    });
  });

  it("builds the noul criteria object", async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(noulBody("is_urgent")));
    await clientWith(fetchImpl).ask({ ticket: "text" }, [
      {
        id: "is_urgent",
        type: "noul",
        instructions: "Is `ticket` urgent?",
        criteria: { true: "time-sensitive", false: "no urgency" },
      },
    ]);
    const body = JSON.parse(calls[0]?.body ?? "{}");
    assert.deepEqual(body.questions.is_urgent.criteria, { true: "time-sensitive", false: "no urgency" });
    assert.deepEqual(body.state, { ticket: "text" });
  });

  it("builds choice criteria with null descriptions", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse({
        model: JEV_MODEL,
        answers: {
          department: {
            type: "choice",
            choice: "technical",
            probabilities: { billing: 0.08, technical: 0.85, sales: 0.07 },
            confidence: 0.82,
          },
        },
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    );
    const response = await clientWith(fetchImpl).ask("state", [
      {
        id: "department",
        type: "choice",
        instructions: "Which team?",
        criteria: { billing: "payments", technical: "bugs", sales: null },
      },
    ]);
    const body = JSON.parse(calls[0]?.body ?? "{}");
    assert.deepEqual(body.questions.department.criteria, {
      billing: "payments",
      technical: "bugs",
      sales: null,
    });
    assert.deepEqual(response.answers.department, {
      type: "choice",
      choice: "technical",
      probabilities: { billing: 0.08, technical: 0.85, sales: 0.07 },
      confidence: 0.82,
    });
  });

  it("builds score criteria as an ordered array and keeps the 0-based legend", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse({
        model: JEV_MODEL,
        answers: {
          frustration: {
            type: "score",
            score: 1.6,
            legend: { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
            probabilities: { "0": 0.05, "1": 0.3, "2": 0.65 },
            confidence: 0.78,
          },
        },
        usage: { input_tokens: 11, output_tokens: 3 },
      }),
    );
    const response = await clientWith(fetchImpl).ask("state", [
      {
        id: "frustration",
        type: "score",
        instructions: "How frustrated?",
        criteria: ["Calm", "Frustrated", "Very angry"],
      },
    ]);
    const body = JSON.parse(calls[0]?.body ?? "{}");
    assert.deepEqual(body.questions.frustration.criteria, ["Calm", "Frustrated", "Very angry"]);
    const answer = response.answers.frustration;
    assert.ok(answer && answer.type === "score");
    assert.equal(answer.score, 1.6);
    assert.deepEqual(answer.legend, { "0": "Calm", "1": "Frustrated", "2": "Very angry" });
  });

  it("sends a mixed batch in one request and preserves usage", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse({
        model: JEV_MODEL,
        answers: {
          is_urgent: { type: "noul", noul: 0.92 },
          department: {
            type: "choice",
            choice: "technical",
            probabilities: { billing: 0.1, technical: 0.9 },
            confidence: 0.8,
          },
          frustration: {
            type: "score",
            score: 2,
            legend: { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
            probabilities: { "0": 0, "1": 0.1, "2": 0.9 },
            confidence: 0.9,
          },
        },
        usage: { input_tokens: 900, output_tokens: 120 },
      }),
    );
    const response = await clientWith(fetchImpl).ask("ticket text", [
      { id: "is_urgent", type: "noul", instructions: "Is it urgent?" },
      { id: "department", type: "choice", instructions: "Which team?", criteria: { billing: null, technical: null } },
      { id: "frustration", type: "score", instructions: "How frustrated?", criteria: ["Calm", "Frustrated", "Very angry"] },
    ]);
    assert.equal(calls.length, 1, "a batch must be one HTTP request");
    const body = JSON.parse(calls[0]?.body ?? "{}");
    assert.deepEqual(Object.keys(body.questions), ["is_urgent", "department", "frustration"]);
    assert.deepEqual(Object.keys(response.answers), ["is_urgent", "department", "frustration"]);
    assert.deepEqual(response.usage, { input_tokens: 900, output_tokens: 120 });
    assert.equal(response.model, JEV_MODEL);
  });
});

describe("request validation before sending", () => {
  const cases: Array<[string, () => unknown]> = [
    ["empty state", () => buildRequestBody("", { q: { type: "noul", instructions: "x" } })],
    ["undefined state", () => buildRequestBody(undefined, { q: { type: "noul", instructions: "x" } })],
    ["numeric state", () => buildRequestBody(42, { q: { type: "noul", instructions: "x" } })],
    ["empty instructions", () => normalizeQuestions([{ id: "q", type: "noul", instructions: "   " }])],
    ["unknown type", () => normalizeQuestions([{ id: "q", type: "noulish", instructions: "x" }])],
    ["empty id", () => normalizeQuestions([{ id: " ", type: "noul", instructions: "x" }])],
    ["duplicate id", () => normalizeQuestions([
      { id: "q", type: "noul", instructions: "x" },
      { id: "q", type: "noul", instructions: "y" },
    ])],
    ["choice without options", () => normalizeQuestions([
      { id: "q", type: "choice", instructions: "x", criteria: {} },
    ])],
    ["choice with non-string description", () => normalizeQuestions([
      { id: "q", type: "choice", instructions: "x", criteria: { a: 3 } },
    ])],
    ["score with one level", () => normalizeQuestions([
      { id: "q", type: "score", instructions: "x", criteria: ["only"] },
    ])],
    ["score with eleven levels", () => normalizeQuestions([
      { id: "q", type: "score", instructions: "x", criteria: Array.from({ length: 11 }, (_v, i) => `level ${i}`) },
    ])],
    ["noul criteria with unknown key", () => normalizeQuestions([
      { id: "q", type: "noul", instructions: "x", criteria: { maybe: "?" } },
    ])],
    ["no questions", () => normalizeQuestions([])],
  ];

  for (const [name, run] of cases) {
    it(`rejects ${name}`, () => {
      assert.throws(run, TypeSafeRequestError);
    });
  }

  it("rejects non-JSON state and circular state", () => {
    assert.throws(() => buildRequestBody({ fn: () => 1 }, { q: { type: "noul", instructions: "x" } }), TypeSafeRequestError);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.throws(() => buildRequestBody(circular, { q: { type: "noul", instructions: "x" } }), TypeSafeRequestError);
  });

  it("omits empty noul criteria instead of sending an empty object", () => {
    const questions = normalizeQuestions([{ id: "q", type: "noul", instructions: "x", criteria: {} }]);
    assert.deepEqual(questions.q, { type: "noul", instructions: "x" });
  });

  it("does not call fetch when validation fails", async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(noulBody()));
    await assert.rejects(
      clientWith(fetchImpl).ask("", [{ id: "q", type: "noul", instructions: "x" }]),
      TypeSafeRequestError,
    );
    assert.equal(calls.length, 0);
  });
});

describe("response parsing", () => {
  const questions = { q: { type: "noul" as const, instructions: "x" } };

  it("accepts the documented noul shape", () => {
    const response = parseSystemOneResponse(JSON.stringify(noulBody("q")), questions);
    assert.deepEqual(response.answers.q, { type: "noul", noul: 0.92 });
    assert.deepEqual(response.usage, { input_tokens: 312, output_tokens: 48 });
  });

  it("rejects malformed bodies instead of inventing an answer", () => {
    const bodies: Array<[string, unknown]> = [
      ["not json", "not json"],
      ["missing model", { answers: { q: { type: "noul", noul: 0.5 } }, usage: { input_tokens: 1, output_tokens: 1 } }],
      ["missing usage", { model: JEV_MODEL, answers: { q: { type: "noul", noul: 0.5 } } }],
      ["missing answer", { model: JEV_MODEL, answers: {}, usage: { input_tokens: 1, output_tokens: 1 } }],
      ["unexpected answer", {
        model: JEV_MODEL,
        answers: { q: { type: "noul", noul: 0.5 }, other: { type: "noul", noul: 0.5 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }],
      ["wrong answer type", {
        model: JEV_MODEL,
        answers: { q: { type: "score", score: 1, legend: { "0": "a" }, probabilities: { "0": 1 }, confidence: 1 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }],
      ["noul above one", {
        model: JEV_MODEL,
        answers: { q: { type: "noul", noul: 1.5 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }],
    ];
    for (const [name, body] of bodies) {
      assert.throws(
        () => parseSystemOneResponse(typeof body === "string" ? body : JSON.stringify(body), questions),
        TypeSafeProtocolError,
        name,
      );
    }
  });

  it("rejects choice answers outside the option set and flat distributions", () => {
    const choiceQuestions = {
      q: { type: "choice" as const, instructions: "x", criteria: { a: null, b: null } },
    };
    const base = { model: JEV_MODEL, usage: { input_tokens: 1, output_tokens: 1 } };
    assert.throws(
      () => parseSystemOneResponse(JSON.stringify({
        ...base,
        answers: { q: { type: "choice", choice: "c", probabilities: { a: 0.5, b: 0.5 }, confidence: 0.5 } },
      }), choiceQuestions),
      TypeSafeProtocolError,
    );
    assert.throws(
      () => parseSystemOneResponse(JSON.stringify({
        ...base,
        answers: { q: { type: "choice", choice: "a", probabilities: { a: 0.15, b: 0.15 }, confidence: 0.5 } },
      }), choiceQuestions),
      TypeSafeProtocolError,
      "probabilities that do not sum to 1 are malformed",
    );
    assert.throws(
      () => parseSystemOneResponse(JSON.stringify({
        ...base,
        answers: { q: { type: "choice", choice: "a", probabilities: { a: 0.5, c: 0.5 }, confidence: 0.5 } },
      }), choiceQuestions),
      TypeSafeProtocolError,
    );
  });

  it("rejects score answers above the highest level or with a mismatched legend", () => {
    const scoreQuestions = {
      q: { type: "score" as const, instructions: "x", criteria: ["low", "high"] },
    };
    const base = { model: JEV_MODEL, usage: { input_tokens: 1, output_tokens: 1 } };
    assert.throws(
      () => parseSystemOneResponse(JSON.stringify({
        ...base,
        answers: { q: { type: "score", score: 5, legend: { "0": "low", "1": "high" }, probabilities: { "0": 0.5, "1": 0.5 }, confidence: 0.5 } },
      }), scoreQuestions),
      TypeSafeProtocolError,
    );
    assert.throws(
      () => parseSystemOneResponse(JSON.stringify({
        ...base,
        answers: { q: { type: "score", score: 1, legend: { "0": "low" }, probabilities: { "0": 1 }, confidence: 0.5 } },
      }), scoreQuestions),
      TypeSafeProtocolError,
    );
  });

  it("turns a non-JSON 200 body into a protocol error", async () => {
    const { fetchImpl } = recordingFetch(() => new Response("<html>proxy</html>", { status: 200 }));
    await assert.rejects(
      clientWith(fetchImpl).ask("state", [{ id: "q", type: "noul", instructions: "x" }]),
      TypeSafeProtocolError,
    );
  });
});

describe("error handling", () => {
  it("maps 401 to an auth error without retrying or leaking the key", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse({ detail: `bad key ${TEST_KEY}` }, 401),
    );
    await assert.rejects(
      clientWith(fetchImpl).ask("state", [{ id: "q", type: "noul", instructions: "x" }]),
      (error: unknown) => {
        assert.ok(error instanceof TypeSafeAuthError);
        assert.ok(!error.message.includes(TEST_KEY));
        assert.match(error.message, /\/typesafe setup/);
        return true;
      },
    );
    assert.equal(calls.length, 1);
  });

  it("maps 422 to a request error and redacts echoed secrets", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse({ detail: `Authorization: Bearer ${TEST_KEY} is malformed` }, 422),
    );
    await assert.rejects(
      clientWith(fetchImpl).ask("state", [{ id: "q", type: "noul", instructions: "x" }]),
      (error: unknown) => {
        assert.ok(error instanceof TypeSafeRequestError);
        assert.ok(!error.message.includes(TEST_KEY));
        assert.match(error.message, /\[redacted\]/);
        return true;
      },
    );
    assert.equal(calls.length, 1, "422 must not be retried");
  });

  it("does not retry other 5xx responses", async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse({ detail: "boom" }, 503));
    await assert.rejects(
      clientWith(fetchImpl).ask("state", [{ id: "q", type: "noul", instructions: "x" }]),
      TypeSafeServerError,
    );
    assert.equal(calls.length, 1);
  });

  it("refuses redirects instead of forwarding the key", async () => {
    const { fetchImpl, calls } = recordingFetch(
      () => new Response(null, { status: 302, headers: { location: "https://evil.example/v1/systemone" } }),
    );
    await assert.rejects(
      clientWith(fetchImpl).ask("state", [{ id: "q", type: "noul", instructions: "x" }]),
      TypeSafeProtocolError,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.init?.redirect, "manual");
  });

  it("does not retry transport failures, because the request may have reached TypeSafe", async () => {
    const { fetchImpl, calls } = recordingFetch(() => {
      throw new TypeError("fetch failed");
    });
    await assert.rejects(
      clientWith(fetchImpl).ask("state", [{ id: "q", type: "noul", instructions: "x" }]),
      TypeSafeNetworkError,
    );
    assert.equal(calls.length, 1);
  });

  it("aborts before sending when the signal is already aborted", async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse(noulBody()));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      clientWith(fetchImpl).ask("state", [{ id: "q", type: "noul", instructions: "x" }], {
        signal: controller.signal,
      }),
      TypeSafeAbortedError,
    );
    assert.equal(calls.length, 0);
  });
});

describe("retries and timeouts", () => {
  function clockHarness(startMs = 1_000_000) {
    let clock = startMs;
    const sleeps: number[] = [];
    return {
      now: () => clock,
      sleeps,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
    };
  }

  it("retries 429 with exponential backoff and then succeeds", async () => {
    const harness = clockHarness();
    const { fetchImpl, calls } = recordingFetch((_call, index) =>
      index === 0 ? jsonResponse({ detail: "slow down" }, 429) : jsonResponse(noulBody("q")),
    );
    const response = await clientWith(fetchImpl, { ...harness, timeoutMs: 60_000 }).ask("state", [
      { id: "q", type: "noul", instructions: "x" },
    ]);
    assert.equal(calls.length, 2);
    assert.deepEqual(harness.sleeps, [500]);
    assert.deepEqual(response.answers.q, { type: "noul", noul: 0.92 });
  });

  it("honours Retry-After but caps it", async () => {
    const harness = clockHarness();
    const { fetchImpl } = recordingFetch((_call, index) =>
      index === 0
        ? jsonResponse({ detail: "slow down" }, 429, { "retry-after": "3600" })
        : jsonResponse(noulBody("q")),
    );
    await clientWith(fetchImpl, { ...harness, timeoutMs: 600_000, maxRetryDelayMs: 2_000 }).ask("state", [
      { id: "q", type: "noul", instructions: "x" },
    ]);
    assert.deepEqual(harness.sleeps, [2_000], "Retry-After must be capped");
  });

  it("honours an HTTP-date Retry-After", async () => {
    const harness = clockHarness();
    const retryAt = new Date(harness.now() + 2_000).toUTCString();
    const { fetchImpl } = recordingFetch((_call, index) =>
      index === 0
        ? jsonResponse({ detail: "slow down" }, 429, { "retry-after": retryAt })
        : jsonResponse(noulBody("q")),
    );
    await clientWith(fetchImpl, { ...harness, timeoutMs: 600_000 }).ask("state", [
      { id: "q", type: "noul", instructions: "x" },
    ]);
    assert.deepEqual(harness.sleeps, [2_000]);
  });

  it("gives up after the attempt budget with a rate-limit error", async () => {
    const harness = clockHarness();
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse({ detail: "slow down" }, 429));
    await assert.rejects(
      clientWith(fetchImpl, { ...harness, timeoutMs: 600_000, maxAttempts: 3 }).ask("state", [
        { id: "q", type: "noul", instructions: "x" },
      ]),
      TypeSafeRateLimitError,
    );
    assert.equal(calls.length, 3);
    assert.deepEqual(harness.sleeps, [500, 1_000], "backoff is bounded and then stops");
  });

  it("retries 529 and reports an overload error when the budget is gone", async () => {
    const harness = clockHarness();
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse({ detail: "overloaded" }, 529));
    await assert.rejects(
      clientWith(fetchImpl, { ...harness, timeoutMs: 600_000, maxAttempts: 2 }).ask("state", [
        { id: "q", type: "noul", instructions: "x" },
      ]),
      TypeSafeOverloadedError,
    );
    assert.equal(calls.length, 2);
  });

  it("does not sleep past the deadline, and never retries unlimited times", async () => {
    const harness = clockHarness();
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse({ detail: "slow down" }, 429, { "retry-after": "60" }),
    );
    await assert.rejects(
      clientWith(fetchImpl, { ...harness, timeoutMs: 1_000, maxAttempts: 5 }).ask("state", [
        { id: "q", type: "noul", instructions: "x" },
      ]),
      TypeSafeRateLimitError,
    );
    assert.equal(calls.length, 1, "the retry must be skipped when the time budget is too small");
    assert.deepEqual(harness.sleeps, []);
  });

  it("times out while reading the response body", async () => {
    let aborted = false;
    const { fetchImpl } = recordingFetch((call) => {
      const stream = new ReadableStream({
        start(streamController) {
          call.init?.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              streamController.error(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        },
      });
      return new Response(stream, { status: 200 });
    });
    const startedAt = Date.now();
    await assert.rejects(
      clientWith(fetchImpl, { timeoutMs: 120 }).ask("state", [{ id: "q", type: "noul", instructions: "x" }]),
      TypeSafeTimeoutError,
    );
    assert.ok(aborted, "the deadline must abort an in-flight body read");
    assert.ok(Date.now() - startedAt < 5_000);
  });

  it("reports caller cancellation while reading the body", async () => {
    const controller = new AbortController();
    const { fetchImpl } = recordingFetch((call) => {
      const stream = new ReadableStream({
        start(streamController) {
          call.init?.signal?.addEventListener(
            "abort",
            () => streamController.error(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        },
      });
      return new Response(stream, { status: 200 });
    });
    const pending = clientWith(fetchImpl, { timeoutMs: 30_000 }).ask(
      "state",
      [{ id: "q", type: "noul", instructions: "x" }],
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending, TypeSafeAbortedError);
  });

  it("rejects an oversized response body", async () => {
    const { fetchImpl } = recordingFetch(
      () => new Response(`{"padding":"${"x".repeat(MAX_RESPONSE_BYTES + 64)}"}`, { status: 200 }),
    );
    await assert.rejects(
      clientWith(fetchImpl).ask("state", [{ id: "q", type: "noul", instructions: "x" }]),
      TypeSafeProtocolError,
    );
  });
});

describe("prototype-safe dictionaries", () => {
  // JSON.parse creates own properties even for "__proto__", which is how these
  // names reach the client from a tool call or from a provider response.
  const parsed = (json: string): Record<string, unknown> => JSON.parse(json) as Record<string, unknown>;

  it("accepts question ids that collide with Object.prototype members", () => {
    const questions = normalizeQuestions([
      { id: "__proto__", type: "noul", instructions: "Is it true?" },
      { id: "constructor", type: "noul", instructions: "Is it true?" },
      { id: "toString", type: "choice", instructions: "Which one?", criteria: { a: null } },
    ]);
    assert.deepEqual(Object.keys(questions).sort(), ["__proto__", "constructor", "toString"]);
    const typed = questions as Record<string, { type?: string } | undefined>;
    assert.equal(Object.hasOwn(questions, "constructor"), true);
    assert.equal(typed["constructor"]?.type, "noul");
    assert.equal(typed["toString"]?.type, "choice");
    assert.equal(typed["__proto__"]?.type, "noul");
    const body = JSON.parse(buildRequestBody("state", questions)) as { questions: Record<string, unknown> };
    assert.deepEqual(Object.keys(body.questions).sort(), ["__proto__", "constructor", "toString"]);
  });

  it("still reports a real duplicate for those ids", () => {
    assert.throws(
      () =>
        normalizeQuestions([
          { id: "constructor", type: "noul", instructions: "a" },
          { id: "constructor", type: "noul", instructions: "b" },
        ]),
      /duplicate question id "constructor"/,
    );
    assert.throws(
      () =>
        normalizeQuestions([
          { id: "__proto__", type: "noul", instructions: "a" },
          { id: "__proto__", type: "noul", instructions: "b" },
        ]),
      /duplicate question id "__proto__"/,
    );
  });

  it("keeps a choice option named __proto__ in the request", () => {
    const questions = normalizeQuestions([
      {
        id: "risk",
        type: "choice",
        instructions: "Does it fit?",
        criteria: parsed('{"__proto__": "an odd option", "constructor": null}'),
      },
    ]);
    const question = questions.risk;
    assert.ok(question && question.type === "choice");
    assert.deepEqual(Object.keys(question.criteria).sort(), ["__proto__", "constructor"]);
    assert.equal(Object.hasOwn(question.criteria, "__proto__"), true);
    const body = JSON.parse(buildRequestBody("state", questions)) as {
      questions: { risk: { criteria: Record<string, unknown> } };
    };
    assert.deepEqual(body.questions.risk.criteria, parsed('{"__proto__": "an odd option", "constructor": null}'));
  });

  it("round-trips answers keyed __proto__ and toString", () => {
    const questions = normalizeQuestions([
      { id: "__proto__", type: "noul", instructions: "a" },
      { id: "toString", type: "choice", instructions: "b", criteria: parsed('{"__proto__": null, "other": null}') },
    ]);
    const response = parseSystemOneResponse(
      JSON.stringify({
        model: JEV_MODEL,
        answers: parsed(
          '{"__proto__": {"type": "noul", "noul": 0.25}, "toString": {"type": "choice", "choice": "__proto__", "probabilities": {"__proto__": 0.75, "other": 0.25}, "confidence": 0.5}}',
        ),
        usage: { input_tokens: 5, output_tokens: 2 },
      }),
      questions,
    );
    assert.deepEqual(Object.keys(response.answers).sort(), ["__proto__", "toString"]);
    assert.deepEqual(answerFor(response, "__proto__", "noul"), { type: "noul", noul: 0.25 });
    const choice = answerFor(response, "toString", "choice");
    assert.equal(choice.choice, "__proto__");
    assert.deepEqual(Object.keys(choice.probabilities).sort(), ["__proto__", "other"]);
    assert.equal(Object.hasOwn(response.answers, "__proto__"), true);
    assert.equal(Object.hasOwn(choice.probabilities, "__proto__"), true);
    assert.equal((choice.probabilities as Record<string, number>)["__proto__"], 0.75);
  });

  it("rejects an unexpected answer id without echoing it", () => {
    const questions = normalizeQuestions([{ id: "q", type: "noul", instructions: "a" }]);
    assert.throws(
      () =>
        parseSystemOneResponse(
          JSON.stringify({
            model: JEV_MODEL,
            answers: parsed('{"q": {"type": "noul", "noul": 0.5}, "constructor": {"type": "noul", "noul": 0.5}}'),
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          questions,
        ),
      (error: unknown) => {
        assert.ok(error instanceof TypeSafeProtocolError);
        assert.match(error.message, /1 unknown question id/);
        assert.ok(!error.message.includes("constructor"), "unexpected ids must not be repeated");
        return true;
      },
    );
  });
});

describe("internal error and response safety", () => {
  const questionsAsInput = (): Array<{ id: string; type: string; instructions: string }> => [
    { id: "q", type: "noul", instructions: "a" },
  ];

  function malformedModelResponse(model: unknown): string {
    return JSON.stringify({
      model,
      answers: { q: { type: "noul", noul: 0.5 } },
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  }

  it("redacts a key echoed by a malformed 200 response", async () => {
    const { fetchImpl } = recordingFetch(() =>
      new Response(malformedModelResponse(`key ${TEST_KEY} leaked`), { status: 200 }),
    );
    await assert.rejects(
      clientWith(fetchImpl).ask("state", questionsAsInput()),
      (error: unknown) => {
        assert.ok(error instanceof TypeSafeProtocolError);
        assert.ok(!error.message.includes(TEST_KEY));
        assert.match(error.message, /model must be a short identifier string/);
        return true;
      },
    );
  });

  it("does not echo the key through a malformed answer or usage value", async () => {
    const bodies = [
      { model: JEV_MODEL, answers: { q: { type: `noul ${TEST_KEY}`, noul: 0.5 } }, usage: { input_tokens: 1, output_tokens: 1 } },
      { model: JEV_MODEL, answers: { q: { type: "noul", noul: `0.5 ${TEST_KEY}` } }, usage: { input_tokens: 1, output_tokens: 1 } },
      { model: JEV_MODEL, answers: { q: { type: "noul", noul: 0.5 } }, usage: { input_tokens: TEST_KEY, output_tokens: 1 } },
      { model: JEV_MODEL, answers: { q: { type: "noul", noul: 0.5 } }, usage: null },
      { model: JEV_MODEL, answers: { q: `noul ${TEST_KEY}` }, usage: { input_tokens: 1, output_tokens: 1 } },
    ];
    for (const body of bodies) {
      const { fetchImpl } = recordingFetch(() => jsonResponse(body));
      await assert.rejects(
        clientWith(fetchImpl).ask("state", questionsAsInput()),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok(!error.message.includes(TEST_KEY), `key leaked in: ${error.message}`);
          return true;
        },
      );
    }
  });

  it("redacts a short key echoed by a malformed 200 response", async () => {
    const shortKey = "k1";
    const { fetchImpl } = recordingFetch(() => jsonResponse(malformedModelResponse(shortKey)));
    await assert.rejects(
      clientWith(fetchImpl, { apiKey: shortKey }).ask("state", questionsAsInput()),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes(shortKey));
        return true;
      },
    );
  });

  it("rejects a successful response whose model echoes the key instead of returning it", async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse(malformedModelResponse(`Bearer ${TEST_KEY}`)));
    await assert.rejects(clientWith(fetchImpl).ask("state", questionsAsInput()), TypeSafeProtocolError);
  });

  it("rejects an identifier-shaped key echoed as the model id", async () => {
    // A key such as "jev-secret-123" matches the model identifier pattern, so the
    // shape check alone cannot catch it; the client compares the key itself.
    const identifierShapedKey = "jev-secret-123";
    const bodies = [
      malformedModelResponse(identifierShapedKey),
      malformedModelResponse(`prefix-${identifierShapedKey}`),
    ];
    for (const body of bodies) {
      const { fetchImpl } = recordingFetch(() => new Response(body, { status: 200 }));
      await assert.rejects(
        clientWith(fetchImpl, { apiKey: identifierShapedKey }).ask("state", questionsAsInput()),
        (error: unknown) => {
          assert.ok(error instanceof TypeSafeProtocolError);
          assert.ok(!error.message.includes(identifierShapedKey), `key leaked: ${error.message}`);
          assert.match(error.message, /model must not repeat the configured API key/);
          return true;
        },
      );
    }
  });

  it("still returns a real model id when it does not repeat the key", async () => {
    // Short keys are only compared for equality, so ordinary model ids keep working.
    const { fetchImpl } = recordingFetch(() => new Response(malformedModelResponse(JEV_MODEL), { status: 200 }));
    const response = await clientWith(fetchImpl, { apiKey: "k1" }).ask("state", questionsAsInput());
    assert.equal(response.model, JEV_MODEL);
  });

  it("rebuilds the score legend from the request instead of echoing provider text", async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse({
        model: JEV_MODEL,
        answers: {
          q: {
            type: "score",
            score: 1,
            legend: { "0": `${TEST_KEY} A`, "1": `${TEST_KEY} B` },
            probabilities: { "0": 0.5, "1": 0.5 },
            confidence: 0.5,
          },
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    const response = await clientWith(fetchImpl).ask("state", [
      { id: "q", type: "score", instructions: "rate", criteria: ["Low", "High"] },
    ]);
    const answer = answerFor(response, "q", "score");
    assert.deepEqual(answer.legend, { "0": "Low", "1": "High" });
    assert.ok(!JSON.stringify(answer).includes(TEST_KEY));
  });

  it("never attaches a raw cause to a safe error", async () => {
    const { fetchImpl } = recordingFetch(() => {
      throw new TypeError(`connect failed while sending ${TEST_KEY}`);
    });
    await assert.rejects(
      clientWith(fetchImpl).ask("state", questionsAsInput()),
      (error: unknown) => {
        assert.ok(error instanceof TypeSafeNetworkError);
        assert.equal(error.cause, undefined);
        assert.ok(!error.message.includes(TEST_KEY));
        return true;
      },
    );
  });

  it("redacts short keys too", () => {
    assert.equal(redactSecrets("answer k1 here", "k1"), "answer [redacted] here");
    assert.equal(redactSecrets("nothing to hide", "k1"), "nothing to hide");
    assert.equal(redactSecrets("goalkeeper", "k1"), "goalkeeper", "embedded matches stay intact");
    assert.equal(redactSecrets("answer " + TEST_KEY, TEST_KEY), "answer [redacted]");
  });
});

describe("redactSecrets", () => {
  it("removes the key and bearer tokens", () => {
    const redacted = redactSecrets(`Bearer ${TEST_KEY} {"authorization":"${TEST_KEY}"}`, TEST_KEY);
    assert.ok(!redacted.includes(TEST_KEY));
    assert.match(redacted, /Bearer \[redacted\]/);
  });
});

/**
 * Offline tests for question files: path resolution, parsing, validation, and
 * `$bind` filling. No network access; every file lives in a temporary directory.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  MAX_QUESTION_FILE_BYTES,
  TypeSafeQuestionFileError,
  bindState,
  displayQuestionFilePath,
  loadQuestionFile,
  resolveQuestionFilePath,
} from "../src/question-file.ts";

let dir = "";

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-typesafe-qfile-"));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(name: string, content: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, content, "utf8");
  return path;
}

const ROUTER_YAML = `
description: ticket router
type: choice
instructions: |
  Which team should handle \`messages\`?
criteria:
  billing: payments and refunds
  technical: bugs and outages
  other: none of the above
state:
  messages: { $bind: messages }
  account: { $bind: account }
  fixed: "always here"
`;

describe("resolveQuestionFilePath", () => {
  it("resolves relative paths against cwd and keeps absolute paths", () => {
    assert.equal(resolveQuestionFilePath("q/router.yaml", "/base"), "/base/q/router.yaml");
    assert.equal(resolveQuestionFilePath("/abs/router.json", "/base"), "/abs/router.json");
  });

  it("refuses unsupported extensions, empty values, and NUL bytes", () => {
    assert.throws(() => resolveQuestionFilePath("router.txt", "/base"), TypeSafeQuestionFileError);
    assert.throws(() => resolveQuestionFilePath("", "/base"), TypeSafeQuestionFileError);
    assert.throws(() => resolveQuestionFilePath("   ", "/base"), TypeSafeQuestionFileError);
    assert.throws(() => resolveQuestionFilePath("a\0b.yaml", "/base"), TypeSafeQuestionFileError);
    assert.throws(() => resolveQuestionFilePath(42, "/base"), TypeSafeQuestionFileError);
  });
});

describe("displayQuestionFilePath", () => {
  it("never returns an absolute path", () => {
    assert.equal(displayQuestionFilePath("/base/q/router.yaml", "/base"), "q/router.yaml");
    assert.equal(displayQuestionFilePath(join(homedir(), "notes", "q.json"), "/base"), "~/notes/q.json");
    assert.equal(displayQuestionFilePath("/elsewhere/private/q.yaml", "/base"), "q.yaml");
  });
});

describe("loadQuestionFile", () => {
  it("loads a YAML choice file and collects bind names in order", async () => {
    const path = await write("router.yaml", ROUTER_YAML);
    const loaded = await loadQuestionFile(path, dir);
    assert.equal(loaded.path, "router.yaml");
    assert.ok(!loaded.path.includes(dir), "the display path must not be absolute");
    assert.equal(loaded.description, "ticket router");
    assert.equal(loaded.question.type, "choice");
    assert.match(String(loaded.question.instructions), /Which team/);
    assert.deepEqual(Object.keys((loaded.question as { criteria: object }).criteria), [
      "billing",
      "technical",
      "other",
    ]);
    assert.deepEqual(loaded.bindNames, ["messages", "account"]);
  });

  it("loads a JSON noul file with a template that has no slots", async () => {
    await write(
      "urgent.json",
      JSON.stringify({
        type: "noul",
        instructions: "Is `text` urgent?",
        criteria: { true: "time-sensitive", false: "not urgent" },
        state: { text: "static" },
      }),
    );
    const loaded = await loadQuestionFile("urgent.json", dir);
    assert.equal(loaded.question.type, "noul");
    assert.deepEqual(loaded.bindNames, []);
    assert.deepEqual(bindState(loaded, undefined), { text: "static" });
  });

  it("loads a score file", async () => {
    const path = await write(
      "mood.yml",
      "type: score\ninstructions: How angry?\ncriteria: [calm, annoyed, furious]\nstate: { $bind: text }\n",
    );
    const loaded = await loadQuestionFile(path, dir);
    assert.equal(loaded.question.type, "score");
    assert.deepEqual(loaded.bindNames, ["text"]);
    assert.equal(bindState(loaded, { text: "grr" }), "grr");
  });

  it("reports a missing file by path", async () => {
    await assert.rejects(loadQuestionFile("nope.yaml", dir), (error: unknown) => {
      assert.ok(error instanceof TypeSafeQuestionFileError);
      assert.match(error.message, /not found/);
      assert.match(error.message, /nope\.yaml/);
      assert.ok(!error.message.includes(dir), "errors must not reveal the absolute path");
      return true;
    });
  });

  it("refuses a symbolic link", async () => {
    const target = await write("real.yaml", ROUTER_YAML);
    const link = join(dir, "link.yaml");
    await symlink(target, link);
    await assert.rejects(loadQuestionFile(link, dir), /symbolic link/);
  });

  it("refuses a directory", async () => {
    const path = join(dir, "adir.yaml");
    await mkdir(path);
    await assert.rejects(loadQuestionFile(path, dir), /not a regular file/);
  });

  it("refuses an oversized file", async () => {
    const path = await write("big.yaml", `${ROUTER_YAML}\n# ${"x".repeat(MAX_QUESTION_FILE_BYTES)}\n`);
    await assert.rejects(loadQuestionFile(path, dir), /larger than/);
  });

  it("reports invalid YAML and invalid JSON", async () => {
    const yaml = await write("bad.yaml", "type: choice\ninstructions: [unclosed\n");
    await assert.rejects(loadQuestionFile(yaml, dir), /could not be parsed/);
    const json = await write("bad.json", "{ not json");
    await assert.rejects(loadQuestionFile(json, dir), /could not be parsed/);
  });

  it("requires a top-level object with a state template", async () => {
    const list = await write("list.yaml", "- a\n- b\n");
    await assert.rejects(loadQuestionFile(list, dir), /single object/);
    const noState = await write("nostate.yaml", "type: noul\ninstructions: x?\n");
    await assert.rejects(loadQuestionFile(noState, dir), /"state" template/);
  });

  it("rejects unknown top-level keys so a typo cannot silently drop a field", async () => {
    const path = await write("extra.yaml", `${ROUTER_YAML}\nbind:\n  messages: leaked\n`);
    await assert.rejects(loadQuestionFile(path, dir), /unsupported top-level key "bind"/);
  });

  it("validates the question through the shared normalizer", async () => {
    const path = await write("badtype.yaml", "type: guess\ninstructions: x?\nstate: {}\n");
    await assert.rejects(loadQuestionFile(path, dir), (error: unknown) => {
      assert.ok(error instanceof TypeSafeQuestionFileError);
      assert.match(error.message, /type must be "noul", "choice", or "score"/);
      assert.ok(!error.message.includes('question "ask":'), "the internal question id must not leak");
      return true;
    });
    const noCriteria = await write("nocrit.yaml", "type: choice\ninstructions: x?\nstate: {}\n");
    await assert.rejects(loadQuestionFile(noCriteria, dir), /choice question requires criteria/);
  });

  it("rejects malformed $bind nodes", async () => {
    const extraKeys = await write(
      "bind-extra.yaml",
      "type: noul\ninstructions: x?\nstate:\n  a: { $bind: name, other: 1 }\n",
    );
    await assert.rejects(loadQuestionFile(extraKeys, dir), /no other keys/);
    const badName = await write("bind-name.yaml", "type: noul\ninstructions: x?\nstate:\n  a: { $bind: 'has space' }\n");
    await assert.rejects(loadQuestionFile(badName, dir), /identifier-like/);
    const numeric = await write("bind-num.yaml", "type: noul\ninstructions: x?\nstate:\n  a: { $bind: 7 }\n");
    await assert.rejects(loadQuestionFile(numeric, dir), /identifier-like/);
  });

  it("does not expand YAML aliases or merge keys", async () => {
    const path = await write(
      "alias.yaml",
      "type: noul\ninstructions: x?\nstate:\n  a: &anchor { $bind: name }\n  b: *anchor\n",
    );
    await assert.rejects(loadQuestionFile(path, dir), /could not be parsed/);
  });
});

describe("bindState", () => {
  it("fills every slot and copies the rest verbatim", async () => {
    const loaded = await loadQuestionFile(await write("fill.yaml", ROUTER_YAML), dir);
    const state = bindState(loaded, {
      messages: ["hello", "world"],
      account: { plan: "pro" },
    });
    assert.deepEqual(state, {
      messages: ["hello", "world"],
      account: { plan: "pro" },
      fixed: "always here",
    });
  });

  it("does not mutate the template between calls", async () => {
    const loaded = await loadQuestionFile(await write("twice.yaml", ROUTER_YAML), dir);
    const first = bindState(loaded, { messages: ["a"], account: 1 }) as Record<string, unknown>;
    (first.messages as string[]).push("mutated");
    const second = bindState(loaded, { messages: ["b"], account: 2 });
    assert.deepEqual(second, { messages: ["b"], account: 2, fixed: "always here" });
  });

  it("names missing and unused bind values", async () => {
    const loaded = await loadQuestionFile(await write("names.yaml", ROUTER_YAML), dir);
    assert.throws(
      () => bindState(loaded, { messages: [] }),
      (error: unknown) => {
        assert.ok(error instanceof TypeSafeQuestionFileError);
        assert.match(error.message, /needs bind value\(s\) for: account/);
        assert.match(error.message, /supplied: messages/);
        return true;
      },
    );
    assert.throws(
      () => bindState(loaded, { messages: [], account: {}, instructions: "override me" }),
      /does not use bind value\(s\): instructions/,
    );
    assert.throws(() => bindState(loaded, { messages: [], account: undefined }), /bind\.account must not be undefined/);
    assert.throws(() => bindState(loaded, "not an object"), /bind must be an object/);
  });

  it("rejects bind values when the template has no slots", async () => {
    const loaded = await loadQuestionFile(
      await write("noslots.yaml", "type: noul\ninstructions: x?\nstate: { fixed: 1 }\n"),
      dir,
    );
    assert.throws(() => bindState(loaded, { extra: 1 }), /template has no slots/);
    assert.deepEqual(bindState(loaded, {}), { fixed: 1 });
  });

  it("handles slots inside arrays and at the root", async () => {
    const loaded = await loadQuestionFile(
      await write("arr.yaml", "type: noul\ninstructions: x?\nstate:\n  items:\n    - { $bind: first }\n    - literal\n    - { $bind: second }\n"),
      dir,
    );
    assert.deepEqual(loaded.bindNames, ["first", "second"]);
    assert.deepEqual(bindState(loaded, { first: 1, second: { deep: true } }), {
      items: [1, "literal", { deep: true }],
    });
  });

  it("keeps hostile keys as own properties", async () => {
    const loaded = await loadQuestionFile(
      await write("proto.yaml", "type: noul\ninstructions: x?\nstate:\n  __proto__: { $bind: p }\n  constructor: fixed\n"),
      dir,
    );
    const state = bindState(loaded, { p: { polluted: true } }) as Record<string, unknown>;
    assert.ok(Object.prototype.hasOwnProperty.call(state, "__proto__"));
    assert.equal(Object.getPrototypeOf(state), Object.prototype);
    assert.equal(({} as Record<string, unknown>).polluted, undefined, "prototype must not be polluted");
    assert.equal(state.constructor, "fixed");
  });
});

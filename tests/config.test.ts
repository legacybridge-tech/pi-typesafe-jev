/**
 * Offline tests for src/config.ts.
 *
 * Every test uses a temporary directory under os.tmpdir(); the real pi agent
 * directory is never read or written.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  CONFIG_DIR_MODE,
  CONFIG_FILE_MODE,
  CredentialStore,
  MAX_API_KEY_CHARS,
  TypeSafeConfigError,
  validateApiKey,
} from "../src/config.ts";

const created: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-typesafe-config-"));
  created.push(dir);
  return dir;
}

after(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

function storeIn(dir: string): CredentialStore {
  return new CredentialStore({ dir });
}

const KEY = "ts_test_key_abcdefghijklmnop";

describe("validateApiKey", () => {
  it("accepts a normal key and trims surrounding whitespace", () => {
    assert.deepEqual(validateApiKey(`  ${KEY}  `), { ok: true, key: KEY });
  });

  it("rejects empty, whitespace, control characters, and over-long values", () => {
    assert.equal(validateApiKey("   ").ok, false);
    assert.equal(validateApiKey("two words").ok, false);
    assert.equal(validateApiKey("line\nbreak").ok, false);
    assert.equal(validateApiKey("emoji-\u{1f600}").ok, false);
    assert.equal(validateApiKey("x".repeat(MAX_API_KEY_CHARS + 1)).ok, false);
  });
});

describe("persistence", () => {
  it("reports not configured before anything is written", async () => {
    const store = storeIn(await tempDir());
    assert.equal(await store.read(), undefined);
    assert.deepEqual(await store.inspect(), { configured: false, path: store.file });
  });

  it("stores and reloads the key across store instances", async () => {
    const dir = await tempDir();
    await storeIn(dir).write(KEY);
    const reloaded = await storeIn(dir).read();
    assert.deepEqual(reloaded, { version: 1, apiKey: KEY });
    assert.deepEqual(await storeIn(dir).inspect(), { configured: true, path: join(dir, "config.json") });
  });

  it("creates a private directory (0700) and a private file (0600)", async () => {
    const dir = await tempDir();
    const store = storeIn(join(dir, "typesafe"));
    await store.write(KEY);
    if (process.platform === "win32") return;
    assert.equal((await stat(store.dir)).mode & 0o777, CONFIG_DIR_MODE);
    assert.equal((await stat(store.file)).mode & 0o777, CONFIG_FILE_MODE);
  });

  it("tightens permissions of an existing file on rewrite", async () => {
    const dir = await tempDir();
    const store = storeIn(dir);
    await store.write(KEY);
    if (process.platform !== "win32") {
      const { chmod } = await import("node:fs/promises");
      await chmod(store.file, 0o644);
    }
    await store.write(`${KEY}_rotated`, { replaceExisting: true });
    if (process.platform === "win32") return;
    assert.equal((await stat(store.file)).mode & 0o777, CONFIG_FILE_MODE);
  });

  it("writes atomically and leaves no temporary files behind", async () => {
    const dir = await tempDir();
    const store = storeIn(dir);
    await store.write(KEY);
    await store.write(`${KEY}_2`, { replaceExisting: true });
    await store.write(`${KEY}_3`, { replaceExisting: true });
    assert.deepEqual(await readdir(dir), ["config.json"]);
    assert.equal((await store.read())?.apiKey, `${KEY}_3`);
  });

  it("refuses to overwrite an existing file without replaceExisting", async () => {
    const dir = await tempDir();
    const store = storeIn(dir);
    await store.write(KEY);
    await assert.rejects(() => store.write(`${KEY}_other`), TypeSafeConfigError);
    assert.equal((await store.read())?.apiKey, KEY, "the stored key must be unchanged");
  });

  it("refuses to store an invalid key without touching the file", async () => {
    const dir = await tempDir();
    const store = storeIn(dir);
    await store.write(KEY);
    await assert.rejects(() => store.write("not a valid key", { replaceExisting: true }), TypeSafeConfigError);
    assert.equal((await store.read())?.apiKey, KEY);
  });
});

describe("fail-closed behaviour", () => {
  it("reports a corrupt file instead of silently replacing it", async () => {
    const dir = await tempDir();
    const store = storeIn(dir);
    await mkdir(dir, { recursive: true });
    await writeFile(store.file, "{not json", "utf8");

    await assert.rejects(() => store.read(), TypeSafeConfigError);
    const status = await store.inspect();
    assert.equal(status.configured, false);
    assert.match(status.problem ?? "", /not valid JSON/);
    await assert.rejects(() => store.write(KEY), TypeSafeConfigError);
    assert.equal(await readFile(store.file, "utf8"), "{not json", "corrupt content must survive a refused write");
    await store.write(KEY, { replaceExisting: true });
    assert.equal((await store.read())?.apiKey, KEY);
  });

  it("rejects an unexpected version, a missing key, and an unusable key", async () => {
    const dir = await tempDir();
    const store = storeIn(dir);
    await writeFile(store.file, JSON.stringify({ version: 99, apiKey: KEY }), "utf8");
    await assert.rejects(() => store.read(), /version/);
    await writeFile(store.file, JSON.stringify({ version: 1 }), "utf8");
    await assert.rejects(() => store.read(), /apiKey/);
    await writeFile(store.file, JSON.stringify({ version: 1, apiKey: "has space" }), "utf8");
    await assert.rejects(() => store.read(), /unusable/);
    await writeFile(store.file, "[1,2,3]", "utf8");
    await assert.rejects(() => store.read(), /JSON object/);
  });

  it("never repeats values taken from a malformed config file", async () => {
    const dir = await tempDir();
    const store = storeIn(dir);
    const malformed = [
      JSON.stringify({ version: KEY, apiKey: KEY }),
      JSON.stringify({ version: 1, apiKey: { nested: KEY } }),
      JSON.stringify({ version: 1, apiKey: `${KEY} has a space` }),
    ];
    for (const content of malformed) {
      await writeFile(store.file, content, "utf8");
      await assert.rejects(() => store.read(), (error: unknown) => {
        assert.ok(error instanceof TypeSafeConfigError);
        assert.ok(!error.message.includes(KEY), `config value leaked: ${error.message}`);
        return true;
      });
      const status = await store.inspect();
      assert.equal(status.configured, false);
      assert.ok(!(status.problem ?? "").includes(KEY), `status leaked: ${status.problem ?? ""}`);
    }
  });

  it("refuses a symlinked config file for read, write, and delete", async () => {
    const dir = await tempDir();
    const victim = join(dir, "victim.json");
    await writeFile(victim, "victim content", "utf8");
    const store = storeIn(join(dir, "typesafe"));
    await mkdir(store.dir, { recursive: true });
    await symlink(victim, store.file);

    await assert.rejects(() => store.read(), /symbolic link/);
    await assert.rejects(() => store.write(KEY, { replaceExisting: true }), /symbolic link/);
    await assert.rejects(() => store.clear(), /symbolic link/);
    assert.equal(await readFile(victim, "utf8"), "victim content");
    const status = await store.inspect();
    assert.equal(status.configured, false);
    assert.match(status.problem ?? "", /symbolic link/);
  });

  it("refuses a config path that is not a regular file", async () => {
    const dir = await tempDir();
    const store = storeIn(dir);
    await mkdir(store.file, { recursive: true });
    await assert.rejects(() => store.read(), /not a regular file/);
    await assert.rejects(() => store.write(KEY, { replaceExisting: true }), /not a regular file/);
    await assert.rejects(() => store.clear(), /not a regular file/);
  });

  it("refuses a symlinked credential directory without touching the target", async () => {
    const root = await tempDir();
    const target = join(root, "target");
    await mkdir(target, { recursive: true });
    const targetConfig = join(target, "config.json");
    await writeFile(targetConfig, `${JSON.stringify({ version: 1, apiKey: KEY }, null, 2)}\n`, "utf8");
    if (process.platform !== "win32") {
      const { chmod } = await import("node:fs/promises");
      await chmod(target, 0o755);
    }
    const targetModeBefore = (await stat(target)).mode & 0o777;
    const linkDir = join(root, "typesafe");
    await symlink(target, linkDir, "dir");

    const store = storeIn(linkDir);
    await assert.rejects(() => store.read(), /symbolic link/);
    await assert.rejects(() => store.write(`${KEY}_rotated`, { replaceExisting: true }), /symbolic link/);
    await assert.rejects(() => store.clear(), /symbolic link/);
    const status = await store.inspect();
    assert.equal(status.configured, false);
    assert.match(status.problem ?? "", /symbolic link/);

    // The link target keeps its contents, its permissions, and its file list.
    assert.equal((await stat(target)).mode & 0o777, targetModeBefore, "the target directory mode must not change");
    assert.equal(JSON.parse(await readFile(targetConfig, "utf8")).apiKey, KEY);
    assert.deepEqual(await readdir(target), ["config.json"]);
  });

  it("refuses a credential directory that is not a directory", async () => {
    const dir = await tempDir();
    const notADirectory = join(dir, "typesafe");
    await writeFile(notADirectory, "plain file", "utf8");
    const store = storeIn(notADirectory);

    await assert.rejects(() => store.read(), /not a directory/);
    await assert.rejects(() => store.write(KEY), /not a directory/);
    await assert.rejects(() => store.clear(), /not a directory/);
    assert.equal(await readFile(notADirectory, "utf8"), "plain file");
  });

  it("rejects a config file larger than the size limit", async () => {
    const dir = await tempDir();
    const store = storeIn(dir);
    await writeFile(store.file, `{"version":1,"apiKey":"${"x".repeat(70 * 1024)}"}`, "utf8");
    await assert.rejects(() => store.read(), /larger than/);
  });
});

describe("logout", () => {
  it("deletes the file and reports whether it existed", async () => {
    const dir = await tempDir();
    const store = storeIn(dir);
    await store.write(KEY);
    assert.equal(await store.clear(), true);
    assert.equal(await store.read(), undefined);
    assert.equal(await store.clear(), false);
    assert.deepEqual(await readdir(dir), []);
  });
});

describe("status output", () => {
  it("never contains the key", async () => {
    const dir = await tempDir();
    const store = storeIn(dir);
    await store.write(KEY);
    const configured = JSON.stringify(await store.inspect());
    assert.ok(!configured.includes(KEY));
    await writeFile(store.file, "{broken", "utf8");
    const broken = JSON.stringify(await store.inspect());
    assert.ok(!broken.includes(KEY));
  });
});

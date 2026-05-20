import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { getAfkHome, isAfkConfig, readConfig, redactConfig, writeConfig } from "../extensions/config.ts";
import type { AfkConfig } from "../extensions/types.ts";

async function tempHome(): Promise<string> {
	return mkdtemp(join(tmpdir(), "pi-afk-config-"));
}

describe("AFK config store", () => {
	it("resolves the default user config directory", () => {
		const home = getAfkHome({ HOME: "/home/test-user" });
		assert.equal(home, "/home/test-user/.pi/agent/afk");
	});

	it("honors PI_AFK_HOME for tests and local overrides", () => {
		const home = getAfkHome({ PI_AFK_HOME: "/tmp/custom-afk", HOME: "/home/test-user" });
		assert.equal(home, "/tmp/custom-afk");
	});

	it("returns undefined when config does not exist", async () => {
		const home = await tempHome();
		assert.equal(await readConfig(home), undefined);
	});

	it("writes and reads a valid config", async () => {
		const home = await tempHome();
		const config: AfkConfig = {
			botToken: "123:secret",
			botUsername: "afk_test_bot",
			chatId: 111,
			userId: 222,
		};

		await writeConfig(config, home);
		assert.deepEqual(await readConfig(home), config);

		const raw = await readFile(join(home, "config.json"), "utf8");
		assert.match(raw, /afk_test_bot/);
	});

	it("ignores malformed config files", async () => {
		const home = await tempHome();
		await writeConfig({ botToken: "123:secret", botUsername: "bot", chatId: 1, userId: 2 }, home);
		const file = join(home, "config.json");
		await import("node:fs/promises").then((fs) => fs.writeFile(file, JSON.stringify({ botToken: 5 }), "utf8"));

		assert.equal(await readConfig(home), undefined);
	});

	it("validates and redacts config", () => {
		const config: AfkConfig = { botToken: "123:secret", botUsername: "bot", chatId: 1, userId: 2 };
		assert.equal(isAfkConfig(config), true);
		assert.equal(isAfkConfig({ botToken: "123:secret" }), false);
		assert.deepEqual(redactConfig(config), { botToken: "<redacted>", botUsername: "bot", chatId: 1, userId: 2 });
	});
});

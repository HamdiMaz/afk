import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
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

	it("trims PI_AFK_HOME overrides", () => {
		const home = getAfkHome({ PI_AFK_HOME: "  /tmp/custom-afk  ", HOME: "/home/test-user" });
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

	it("rejects invalid config writes without creating config.json", async () => {
		const home = await tempHome();
		await assert.rejects(
			writeConfig({ botToken: "   ", botUsername: "bot", chatId: 1, userId: 2 } as AfkConfig, home),
			/Invalid AFK config/,
		);

		await assert.rejects(readFile(join(home, "config.json"), "utf8"), { code: "ENOENT" });
	});

	it(
		"creates and enforces restrictive config directory and file permissions",
		{ skip: process.platform === "win32" ? "POSIX mode assertions do not apply on Windows" : false },
		async () => {
			const home = await tempHome();
			const file = join(home, "config.json");
			await chmod(home, 0o777);
			await writeFile(file, "{}", { encoding: "utf8", mode: 0o666 });
			await chmod(file, 0o666);

			await writeConfig({ botToken: "123:secret", botUsername: "bot", chatId: 1, userId: 2 }, home);

			assert.equal((await stat(home)).mode & 0o777, 0o700);
			assert.equal((await stat(file)).mode & 0o777, 0o600);
		},
	);

	it(
		"repairs permissive config directory and file permissions while reading valid config",
		{ skip: process.platform === "win32" ? "POSIX mode assertions do not apply on Windows" : false },
		async () => {
			const home = await tempHome();
			const file = join(home, "config.json");
			const config: AfkConfig = { botToken: "123:secret", botUsername: "bot", chatId: 1, userId: 2 };
			await chmod(home, 0o777);
			await writeFile(file, JSON.stringify(config), { encoding: "utf8", mode: 0o666 });
			await chmod(file, 0o666);

			assert.deepEqual(await readConfig(home), config);
			assert.equal((await stat(home)).mode & 0o777, 0o700);
			assert.equal((await stat(file)).mode & 0o777, 0o600);
		},
	);

	it(
		"repairs permissive permissions while reading invalid JSON config files",
		{ skip: process.platform === "win32" ? "POSIX mode assertions do not apply on Windows" : false },
		async () => {
			const home = await tempHome();
			const file = join(home, "config.json");
			await chmod(home, 0o777);
			await writeFile(file, "{not json", { encoding: "utf8", mode: 0o666 });
			await chmod(file, 0o666);

			assert.equal(await readConfig(home), undefined);
			assert.equal((await stat(home)).mode & 0o777, 0o700);
			assert.equal((await stat(file)).mode & 0o777, 0o600);
		},
	);

	it(
		"repairs permissive permissions while reading schema-invalid config files",
		{ skip: process.platform === "win32" ? "POSIX mode assertions do not apply on Windows" : false },
		async () => {
			const home = await tempHome();
			const file = join(home, "config.json");
			await chmod(home, 0o777);
			await writeFile(file, JSON.stringify({ botToken: 5 }), { encoding: "utf8", mode: 0o666 });
			await chmod(file, 0o666);

			assert.equal(await readConfig(home), undefined);
			assert.equal((await stat(home)).mode & 0o777, 0o700);
			assert.equal((await stat(file)).mode & 0o777, 0o600);
		},
	);

	it("surfaces unexpected read errors", async () => {
		const home = await tempHome();
		await mkdir(join(home, "config.json"));

		await assert.rejects(readConfig(home));
	});

	it(
		"rejects existing non-empty AFK home directories with unrelated files without chmoding them",
		{ skip: process.platform === "win32" ? "POSIX mode assertions do not apply on Windows" : false },
		async () => {
			const home = await tempHome();
			await chmod(home, 0o777);
			await writeFile(join(home, "unrelated.txt"), "do not touch", "utf8");

			await assert.rejects(
				writeConfig({ botToken: "123:secret", botUsername: "bot", chatId: 1, userId: 2 }, home),
				/unsafe AFK home/i,
			);
			assert.equal((await stat(home)).mode & 0o777, 0o777);
			await assert.rejects(readFile(join(home, "config.json"), "utf8"), { code: "ENOENT" });
		},
	);

	it(
		"rejects symlink AFK home paths",
		{ skip: process.platform === "win32" ? "POSIX symlink assertions do not apply on Windows" : false },
		async () => {
			const base = await tempHome();
			const target = join(base, "target");
			const home = join(base, "link-home");
			await mkdir(target);
			await symlink(target, home, "dir");

			await assert.rejects(
				writeConfig({ botToken: "123:secret", botUsername: "bot", chatId: 1, userId: 2 }, home),
				/symlink/i,
			);
			await assert.rejects(readFile(join(target, "config.json"), "utf8"), { code: "ENOENT" });
		},
	);

	it("drops extra properties while reading valid config files", async () => {
		const home = await tempHome();
		await writeFile(
			join(home, "config.json"),
			JSON.stringify({ botToken: "123:secret", botUsername: "bot", chatId: 1, userId: 2, extra: "drop me" }),
			"utf8",
		);

		assert.deepEqual(await readConfig(home), { botToken: "123:secret", botUsername: "bot", chatId: 1, userId: 2 });
	});

	it("drops extra properties while writing config files", async () => {
		const home = await tempHome();
		await writeConfig(
			{ botToken: "123:secret", botUsername: "bot", chatId: 1, userId: 2, extra: "drop me" } as AfkConfig,
			home,
		);

		assert.deepEqual(JSON.parse(await readFile(join(home, "config.json"), "utf8")), {
			botToken: "123:secret",
			botUsername: "bot",
			chatId: 1,
			userId: 2,
		});
	});

	it("validates and redacts config", () => {
		const config: AfkConfig = { botToken: "123:secret", botUsername: "bot", chatId: 1, userId: 2 };
		assert.equal(isAfkConfig(config), true);
		assert.equal(isAfkConfig({ botToken: "123:secret" }), false);
		assert.deepEqual(redactConfig(config), { botToken: "<redacted>", botUsername: "bot", chatId: 1, userId: 2 });
	});

	it("drops extra properties while redacting config", () => {
		const config = { botToken: "123:secret", botUsername: "bot", chatId: 1, userId: 2, extra: "drop me" } as AfkConfig;

		assert.deepEqual(redactConfig(config), { botToken: "<redacted>", botUsername: "bot", chatId: 1, userId: 2 });
	});

	it("rejects fractional, unsafe, or non-positive Telegram IDs", () => {
		const base = { botToken: "123:secret", botUsername: "bot", chatId: 1, userId: 2 };

		assert.equal(isAfkConfig({ ...base, chatId: 1.5 }), false);
		assert.equal(isAfkConfig({ ...base, userId: 2.5 }), false);
		assert.equal(isAfkConfig({ ...base, chatId: Number.MAX_SAFE_INTEGER + 1 }), false);
		assert.equal(isAfkConfig({ ...base, userId: Number.MAX_SAFE_INTEGER + 1 }), false);
		assert.equal(isAfkConfig({ ...base, chatId: 0 }), false);
		assert.equal(isAfkConfig({ ...base, userId: 0 }), false);
		assert.equal(isAfkConfig({ ...base, chatId: -1 }), false);
		assert.equal(isAfkConfig({ ...base, userId: -1 }), false);
	});

	it("rejects whitespace-only bot tokens and usernames", () => {
		const base = { botToken: "123:secret", botUsername: "bot", chatId: 1, userId: 2 };

		assert.equal(isAfkConfig({ ...base, botToken: "   " }), false);
		assert.equal(isAfkConfig({ ...base, botUsername: "\t\n" }), false);
	});
});

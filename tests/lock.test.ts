import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AfkLock, lockPathForToken, type AfkLockOptions, type LockAcquireResult, type LockOwner } from "../extensions/lock.ts";

async function tempHome(): Promise<string> {
	return mkdtemp(join(tmpdir(), "pi-afk-lock-"));
}

describe("AFK bot-token process lock", () => {
	it("returns a hashed .lock path under home/locks without leaking token text", async () => {
		const home = await tempHome();
		const token = "123456:super-secret-token";
		const expectedHash = createHash("sha256").update(token).digest("hex").slice(0, 32);

		const path = lockPathForToken(token, home);

		assert.equal(path, join(home, "locks", `${expectedHash}.lock`));
		assert.equal(path.includes(token), false);
		assert.match(path, /\.lock$/);
	});

	it("acquires a lock containing the owner pid and releases it so another lock can acquire", async () => {
		const home = await tempHome();
		const token = "123:release-test";
		const first = new AfkLock(token, home);
		const second = new AfkLock(token, home);

		const firstResult = await first.acquire();
		assert.deepEqual(firstResult, { ok: true });

		const owner = JSON.parse(await readFile(lockPathForToken(token, home), "utf8")) as LockOwner;
		assert.equal(owner.pid, process.pid);
		assert.equal(typeof owner.createdAt, "number");
		assert.equal(owner.cwd, process.cwd());

		await first.release();
		assert.deepEqual(await second.acquire(), { ok: true });
		await second.release();
	});

	it("rejects a second lock while the first live owner is alive", async () => {
		const home = await tempHome();
		const token = "123:busy-test";
		const first = new AfkLock(token, home);
		const second = new AfkLock(token, home);

		assert.deepEqual(await first.acquire(), { ok: true });
		const result: LockAcquireResult = await second.acquire();

		assert.equal(result.ok, false);
		assert.equal(result.owner?.pid, process.pid);
		assert.equal(typeof result.reason, "string");
		assert.notEqual(result.reason.length, 0);

		await first.release();
	});

	it("recovers a stale lock when isProcessAlive returns false", async () => {
		const home = await tempHome();
		const token = "123:stale-test";
		const lockPath = lockPathForToken(token, home);
		await mkdir(join(home, "locks"), { recursive: true });
		await writeFile(lockPath, JSON.stringify({ pid: 987654321, createdAt: Date.now() - 60_000, cwd: "/old" }), "utf8");

		const options: AfkLockOptions = {
			isProcessAlive(pid) {
				assert.equal(pid, 987654321);
				return false;
			},
		};
		const lock = new AfkLock(token, home, options);

		assert.deepEqual(await lock.acquire(), { ok: true });
		const owner = JSON.parse(await readFile(lockPath, "utf8")) as LockOwner;
		assert.equal(owner.pid, process.pid);
		assert.notEqual(owner.cwd, "/old");

		await lock.release();
	});

	it("supports the plan-style constructor with options", async () => {
		const home = await tempHome();
		const lock = new AfkLock("123:secret", home, { pid: 1234, isProcessAlive: () => true });

		assert.deepEqual(await lock.acquire(), { ok: true });

		const owner = JSON.parse(await readFile(lockPathForToken("123:secret", home), "utf8")) as LockOwner;
		assert.equal(owner.pid, 1234);
		assert.equal(typeof owner.createdAt, "number");

		await lock.release();
	});

	it("recovers a malformed old lock", async () => {
		const home = await tempHome();
		const token = "123:malformed-old";
		const lockPath = lockPathForToken(token, home);
		await mkdir(join(home, "locks"), { recursive: true });
		await writeFile(lockPath, "{not json", "utf8");
		const old = new Date(Date.now() - 10_000);
		await utimes(lockPath, old, old);

		const lock = new AfkLock(token, home, { invalidLockStaleMs: 1 });

		assert.deepEqual(await lock.acquire(), { ok: true });
		const owner = JSON.parse(await readFile(lockPath, "utf8")) as LockOwner;
		assert.equal(owner.pid, process.pid);

		await lock.release();
	});

	it("does not immediately remove or acquire a fresh malformed lock", async () => {
		const home = await tempHome();
		const token = "123:malformed-fresh";
		const lockPath = lockPathForToken(token, home);
		await mkdir(join(home, "locks"), { recursive: true });
		await writeFile(lockPath, "", "utf8");

		const lock = new AfkLock(token, home, { invalidLockStaleMs: 60_000 });
		const result = await lock.acquire();

		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.owner, undefined);
		assert.equal(await readFile(lockPath, "utf8"), "");
	});

	it("does not delete a changed owner during stale cleanup", async () => {
		const home = await tempHome();
		const token = "123:changed-during-cleanup";
		const lockPath = lockPathForToken(token, home);
		await mkdir(join(home, "locks"), { recursive: true });
		await writeFile(lockPath, JSON.stringify({ pid: 1111, createdAt: Date.now() - 60_000, cwd: "/old" }), "utf8");
		const replacementOwner: LockOwner = { pid: 2222, createdAt: Date.now(), cwd: "/new" };

		const lock = new AfkLock(token, home, {
			isProcessAlive(pid) {
				assert.equal(pid, 1111);
				writeFileSync(lockPath, `${JSON.stringify(replacementOwner)}\n`, "utf8");
				return false;
			},
		});

		const result = await lock.acquire();

		assert.equal(result.ok, false);
		assert.deepEqual(JSON.parse(await readFile(lockPath, "utf8")), replacementOwner);
	});

	it("release does not remove a lock overwritten by a different owner", async () => {
		const home = await tempHome();
		const token = "123:release-overwrite";
		const lockPath = lockPathForToken(token, home);
		const lock = new AfkLock(token, home);
		assert.deepEqual(await lock.acquire(), { ok: true });

		const otherOwner: LockOwner = { pid: 4321, createdAt: Date.now(), cwd: "/other" };
		await writeFile(lockPath, `${JSON.stringify(otherOwner)}\n`, "utf8");

		await lock.release();

		assert.deepEqual(JSON.parse(await readFile(lockPath, "utf8")), otherOwner);
	});

	it("rejects an existing symlink lock directory", { skip: process.platform === "win32" }, async () => {
		const home = await tempHome();
		const target = await tempHome();
		await symlink(target, join(home, "locks"), "dir");

		const lock = new AfkLock("123:symlink", home);
		await assert.rejects(() => lock.acquire(), /lock directory/i);
	});
});

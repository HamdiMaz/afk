import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
		const first = new AfkLock({ token, home });
		const second = new AfkLock({ token, home });

		const firstResult = await first.acquire();
		assert.deepEqual(firstResult, { ok: true });

		const owner = JSON.parse(await readFile(lockPathForToken(token, home), "utf8")) as LockOwner;
		assert.equal(owner.pid, process.pid);
		assert.equal(typeof owner.createdAt, "string");
		assert.equal(owner.cwd, process.cwd());

		await first.release();
		assert.deepEqual(await second.acquire(), { ok: true });
		await second.release();
	});

	it("rejects a second lock while the first live owner is alive", async () => {
		const home = await tempHome();
		const token = "123:busy-test";
		const first = new AfkLock({ token, home });
		const second = new AfkLock({ token, home });

		assert.deepEqual(await first.acquire(), { ok: true });
		const result: LockAcquireResult = await second.acquire();

		assert.equal(result.ok, false);
		assert.equal(result.owner.pid, process.pid);
		assert.equal(typeof result.reason, "string");
		assert.notEqual(result.reason.length, 0);

		await first.release();
	});

	it("recovers a stale lock when isProcessAlive returns false", async () => {
		const home = await tempHome();
		const token = "123:stale-test";
		const lockPath = lockPathForToken(token, home);
		await mkdir(join(home, "locks"), { recursive: true });
		await writeFile(lockPath, JSON.stringify({ pid: 987654321, createdAt: "2024-01-01T00:00:00.000Z", cwd: "/old" }), "utf8");

		const options: AfkLockOptions = {
			token,
			home,
			isProcessAlive(pid) {
				assert.equal(pid, 987654321);
				return false;
			},
		};
		const lock = new AfkLock(options);

		assert.deepEqual(await lock.acquire(), { ok: true });
		const owner = JSON.parse(await readFile(lockPath, "utf8")) as LockOwner;
		assert.equal(owner.pid, process.pid);
		assert.notEqual(owner.cwd, "/old");

		await lock.release();
	});
});

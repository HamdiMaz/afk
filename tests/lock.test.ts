import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { AfkLock, lockPathForToken, type AfkLockOptions, type LockAcquireResult, type LockOwner } from "../extensions/lock.ts";

async function tempHome(): Promise<string> {
	return mkdtemp(join(tmpdir(), "pi-afk-lock-"));
}

function ownerPathForToken(token: string, home: string): string {
	return join(lockPathForToken(token, home), "owner.json");
}

async function readOwner(token: string, home: string): Promise<LockOwner> {
	return JSON.parse(await readFile(ownerPathForToken(token, home), "utf8")) as LockOwner;
}

async function writeOwnerDirectory(token: string, home: string, ownerRaw: string): Promise<string> {
	const lockPath = lockPathForToken(token, home);
	await mkdir(lockPath, { recursive: true, mode: 0o700 });
	await writeFile(join(lockPath, "owner.json"), ownerRaw, "utf8");
	return lockPath;
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

	it("acquires a lock directory containing owner metadata and releases it so another lock can acquire", async () => {
		const home = await tempHome();
		const token = "123:release-test";
		const first = new AfkLock(token, home);
		const second = new AfkLock(token, home);

		const firstResult = await first.acquire();
		assert.deepEqual(firstResult, { ok: true });

		const lockPath = lockPathForToken(token, home);
		assert.equal((await lstat(lockPath)).isDirectory(), true);
		const owner = await readOwner(token, home);
		assert.equal(owner.pid, process.pid);
		assert.equal(typeof owner.createdAt, "number");
		assert.equal(owner.cwd, process.cwd());

		await first.release();
		assert.deepEqual(await second.acquire(), { ok: true });
		await second.release();
	});

	it("supports the plan-style constructor with options", async () => {
		const home = await tempHome();
		const lock = new AfkLock("123:secret", home, { pid: 1234, isProcessAlive: () => true });

		assert.deepEqual(await lock.acquire(), { ok: true });

		const owner = await readOwner("123:secret", home);
		assert.equal(owner.pid, 1234);
		assert.equal(typeof owner.createdAt, "number");

		await lock.release();
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

	it("recovers a stale owner lock directory when isProcessAlive returns false", async () => {
		const home = await tempHome();
		const token = "123:stale-test";
		await mkdir(join(home, "locks"), { recursive: true });
		await writeOwnerDirectory(token, home, JSON.stringify({ pid: 987654321, createdAt: Date.now() - 60_000, cwd: "/old" }));

		const options: AfkLockOptions = {
			isProcessAlive(pid) {
				assert.equal(pid, 987654321);
				return false;
			},
		};
		const lock = new AfkLock(token, home, options);

		assert.deepEqual(await lock.acquire(), { ok: true });
		const owner = await readOwner(token, home);
		assert.equal(owner.pid, process.pid);
		assert.notEqual(owner.cwd, "/old");

		await lock.release();
	});

	it("does not immediately remove or acquire a fresh lock directory with missing owner metadata", async () => {
		const home = await tempHome();
		const token = "123:missing-fresh";
		const lockPath = lockPathForToken(token, home);
		await mkdir(lockPath, { recursive: true });

		const lock = new AfkLock(token, home, { invalidLockStaleMs: 60_000 });
		const result = await lock.acquire();

		assert.equal(result.ok, false);
		assert.equal((await lstat(lockPath)).isDirectory(), true);
	});

	it("does not immediately remove or acquire a fresh lock directory with invalid owner metadata", async () => {
		const home = await tempHome();
		const token = "123:malformed-fresh";
		const lockPath = await writeOwnerDirectory(token, home, "{not json");

		const lock = new AfkLock(token, home, { invalidLockStaleMs: 60_000 });
		const result = await lock.acquire();

		assert.equal(result.ok, false);
		assert.equal(await readFile(join(lockPath, "owner.json"), "utf8"), "{not json");
	});

	it("treats recently changed invalid owner metadata as fresh even in an old lock directory", async () => {
		const home = await tempHome();
		const token = "123:malformed-owner-fresh";
		const lockPath = await writeOwnerDirectory(token, home, "{not json");
		const old = new Date(Date.now() - 120_000);
		await utimes(lockPath, old, old);

		const lock = new AfkLock(token, home, { invalidLockStaleMs: 60_000 });
		const result = await lock.acquire();

		assert.equal(result.ok, false);
		assert.equal(await readFile(join(lockPath, "owner.json"), "utf8"), "{not json");
	});

	it("recovers an old invalid owner lock directory", async () => {
		const home = await tempHome();
		const token = "123:malformed-old";
		const lockPath = await writeOwnerDirectory(token, home, "{not json");
		const old = new Date(Date.now() - 10_000);
		await utimes(lockPath, old, old);
		await utimes(join(lockPath, "owner.json"), old, old);

		const lock = new AfkLock(token, home, { invalidLockStaleMs: 1 });

		assert.deepEqual(await lock.acquire(), { ok: true });
		const owner = await readOwner(token, home);
		assert.equal(owner.pid, process.pid);

		await lock.release();
	});

	it("does not delete a newly acquired lock when another contender already claimed a stale directory", async () => {
		const home = await tempHome();
		const token = "123:stale-claim-race";
		const lockPath = await writeOwnerDirectory(token, home, JSON.stringify({ pid: 1111, createdAt: Date.now() - 60_000, cwd: "/old" }));
		const claimedPath = join(dirname(lockPath), `.${basename(lockPath)}.claimed-for-test`);
		await rename(lockPath, claimedPath);

		const winner = new AfkLock(token, home, { pid: 2222, cwd: "/winner", isProcessAlive: () => true });
		assert.deepEqual(await winner.acquire(), { ok: true });

		await rm(claimedPath, { recursive: true, force: true });
		const contender = new AfkLock(token, home, { pid: 3333, isProcessAlive: () => true });
		const result = await contender.acquire();

		assert.equal(result.ok, false);
		assert.equal(result.owner?.pid, 2222);
		assert.deepEqual(await readOwner(token, home), { pid: 2222, cwd: "/winner", createdAt: result.owner?.createdAt });
		await winner.release();
	});

	it("release does not remove a lock directory whose owner metadata was overwritten", async () => {
		const home = await tempHome();
		const token = "123:release-overwrite";
		const lock = new AfkLock(token, home);
		assert.deepEqual(await lock.acquire(), { ok: true });

		const otherOwner: LockOwner = { pid: 4321, createdAt: Date.now(), cwd: "/other" };
		await writeFile(ownerPathForToken(token, home), `${JSON.stringify(otherOwner)}\n`, "utf8");

		await lock.release();

		assert.deepEqual(await readOwner(token, home), otherOwner);
	});

	it("rejects an existing symlink lock directory", { skip: process.platform === "win32" }, async () => {
		const home = await tempHome();
		const target = await tempHome();
		await symlink(target, join(home, "locks"), "dir");

		const lock = new AfkLock("123:symlink", home);
		await assert.rejects(() => lock.acquire(), /lock directory/i);
	});

	it("rejects an existing non-directory lock directory path", async () => {
		const home = await tempHome();
		await mkdir(home, { recursive: true });
		await writeFile(join(home, "locks"), "not a directory", "utf8");

		const lock = new AfkLock("123:nondir-locks", home);
		await assert.rejects(() => lock.acquire(), /lock directory/i);
	});

	it("rejects an existing symlink AFK home", { skip: process.platform === "win32" }, async () => {
		const parent = await tempHome();
		const target = await tempHome();
		const home = join(parent, "home-link");
		await symlink(target, home, "dir");

		const lock = new AfkLock("123:home-symlink", home);
		await assert.rejects(() => lock.acquire(), /AFK home.*symlink/i);
	});

	it("rejects an existing non-directory lock path", async () => {
		const home = await tempHome();
		const token = "123:old-file";
		const lockPath = lockPathForToken(token, home);
		mkdirSync(dirname(lockPath), { recursive: true });
		writeFileSync(lockPath, "old file lock", "utf8");

		const lock = new AfkLock(token, home);
		await assert.rejects(() => lock.acquire(), /lock path.*not a directory/i);
	});
});

import { createHash, randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, open, readFile, rm, stat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { getAfkHome } from "./config.ts";

export interface LockOwner {
	pid: number;
	createdAt: number;
	cwd: string;
}

export type LockAcquireResult = { ok: true } | { ok: false; owner?: LockOwner; reason: string };

export interface AfkLockOptions {
	pid?: number;
	cwd?: string;
	isProcessAlive?: (pid: number) => boolean;
	invalidLockStaleMs?: number;
}

interface LegacyAfkLockOptions extends AfkLockOptions {
	token: string;
	home: string;
}

const DEFAULT_INVALID_LOCK_STALE_MS = 30_000;

export function lockPathForToken(token: string, home = getAfkHome()): string {
	const hash = createHash("sha256").update(token).digest("hex").slice(0, 32);
	return join(home, "locks", `${hash}.lock`);
}

function defaultIsProcessAlive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;

	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error && typeof error === "object" && "code" in error) {
			if (error.code === "ESRCH") return false;
			if (error.code === "EPERM") return true;
		}
		return false;
	}
}

function hasErrorCode(error: unknown, code: string): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function parseLockOwner(raw: string): LockOwner | undefined {
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object") return undefined;
		const candidate = parsed as Record<string, unknown>;
		if (!Number.isSafeInteger(candidate.pid) || Number(candidate.pid) <= 0) return undefined;
		if (typeof candidate.createdAt !== "number" || !Number.isFinite(candidate.createdAt)) return undefined;
		if (typeof candidate.cwd !== "string" || candidate.cwd.length === 0) return undefined;
		return { pid: candidate.pid as number, createdAt: candidate.createdAt, cwd: candidate.cwd };
	} catch (error) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
}

function sameOwner(left: LockOwner, right: LockOwner): boolean {
	return left.pid === right.pid && left.createdAt === right.createdAt && left.cwd === right.cwd;
}

async function syncDirectory(path: string): Promise<void> {
	const handle = await open(path, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function safeRemoveIfUnchanged(path: string, expectedRaw: string): Promise<boolean> {
	let currentRaw: string;
	try {
		currentRaw = await readFile(path, "utf8");
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return false;
		throw error;
	}
	if (currentRaw !== expectedRaw) return false;
	await rm(path, { force: true });
	return true;
}

export class AfkLock {
	private readonly token: string;
	private readonly home: string;
	private readonly path: string;
	private readonly lockDir: string;
	private readonly pid: number;
	private readonly cwd: string;
	private readonly isProcessAlive: (pid: number) => boolean;
	private readonly invalidLockStaleMs: number;
	private acquiredOwner: LockOwner | undefined;

	constructor(token: string, home?: string, options?: AfkLockOptions);
	constructor(options: LegacyAfkLockOptions);
	constructor(tokenOrOptions: string | LegacyAfkLockOptions, home = getAfkHome(), options: AfkLockOptions = {}) {
		if (typeof tokenOrOptions === "string") {
			this.token = tokenOrOptions;
			this.home = home;
		} else {
			this.token = tokenOrOptions.token;
			this.home = tokenOrOptions.home;
			options = tokenOrOptions;
		}
		this.path = lockPathForToken(this.token, this.home);
		this.lockDir = join(this.home, "locks");
		this.pid = options.pid ?? process.pid;
		this.cwd = options.cwd ?? process.cwd();
		this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
		this.invalidLockStaleMs = options.invalidLockStaleMs ?? DEFAULT_INVALID_LOCK_STALE_MS;
	}

	async acquire(): Promise<LockAcquireResult> {
		await this.ensureLockDir();

		for (;;) {
			const owner: LockOwner = { pid: this.pid, createdAt: Date.now(), cwd: this.cwd };
			const rawOwner = `${JSON.stringify(owner)}\n`;
			const publishResult = await this.tryPublishOwner(rawOwner);
			if (publishResult === "published") {
				this.acquiredOwner = owner;
				return { ok: true };
			}

			const existing = await this.readExistingLock();
			if (!existing) continue;

			if (!existing.owner) {
				if (!(await this.isInvalidLockStale())) {
					return { ok: false, reason: "lock file is invalid and fresh" };
				}
				if (await safeRemoveIfUnchanged(this.path, existing.raw)) continue;
				return { ok: false, reason: "lock changed during invalid cleanup" };
			}

			if (this.isProcessAlive(existing.owner.pid)) {
				return { ok: false, owner: existing.owner, reason: "owner process is alive" };
			}

			if (await safeRemoveIfUnchanged(this.path, existing.raw)) continue;
			const changed = await this.readExistingLock();
			if (changed?.owner) return { ok: false, owner: changed.owner, reason: "lock changed during stale cleanup" };
			return { ok: false, reason: "lock changed during stale cleanup" };
		}
	}

	async release(): Promise<void> {
		if (!this.acquiredOwner) return;
		const existing = await this.readExistingLock();
		if (existing?.owner && sameOwner(existing.owner, this.acquiredOwner)) {
			await safeRemoveIfUnchanged(this.path, existing.raw);
		}
		this.acquiredOwner = undefined;
	}

	private async ensureLockDir(): Promise<void> {
		await mkdir(this.home, { recursive: true, mode: 0o700 });
		try {
			await mkdir(this.lockDir, { mode: 0o700 });
		} catch (error) {
			if (!hasErrorCode(error, "EEXIST")) throw error;
		}

		const info = await lstat(this.lockDir);
		if (info.isSymbolicLink() || !info.isDirectory()) {
			throw new Error(`lock directory must be a real directory: ${this.lockDir}`);
		}
		await chmod(this.lockDir, 0o700);
		await syncDirectory(this.lockDir);
	}

	private async tryPublishOwner(rawOwner: string): Promise<"published" | "exists"> {
		const tempPath = join(this.lockDir, `.${basename(this.path)}.${process.pid}.${randomUUID()}.tmp`);
		let handle;
		try {
			handle = await open(tempPath, "wx", 0o600);
			await handle.writeFile(rawOwner, "utf8");
			await handle.sync();
		} finally {
			await handle?.close();
		}

		try {
			await link(tempPath, this.path);
			await unlink(tempPath);
			await syncDirectory(this.lockDir);
			return "published";
		} catch (error) {
			await rm(tempPath, { force: true });
			if (hasErrorCode(error, "EEXIST")) return "exists";
			throw error;
		}
	}

	private async readExistingLock(): Promise<{ raw: string; owner: LockOwner | undefined } | undefined> {
		try {
			const raw = await readFile(this.path, "utf8");
			return { raw, owner: parseLockOwner(raw) };
		} catch (error) {
			if (hasErrorCode(error, "ENOENT")) return undefined;
			throw error;
		}
	}

	private async isInvalidLockStale(): Promise<boolean> {
		try {
			const info = await stat(this.path);
			return Date.now() - info.mtimeMs > this.invalidLockStaleMs;
		} catch (error) {
			if (hasErrorCode(error, "ENOENT")) return false;
			throw error;
		}
	}
}

import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
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
const OWNER_FILE = "owner.json";

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

async function fsyncDirectory(path: string): Promise<void> {
	if (process.platform === "win32") return;

	let handle;
	try {
		handle = await open(path, "r");
		await handle.sync();
	} catch (error) {
		if (error && typeof error === "object" && "code" in error) {
			const code = error.code;
			if (code === "EINVAL" || code === "ENOTSUP" || code === "EISDIR" || code === "EPERM") return;
		}
		throw error;
	} finally {
		await handle?.close();
	}
}

async function validateExistingDirectory(path: string, label: string): Promise<boolean> {
	let info;
	try {
		info = await lstat(path);
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return false;
		throw error;
	}

	if (info.isSymbolicLink()) throw new Error(`${label} is a symlink: ${path}`);
	if (!info.isDirectory()) throw new Error(`${label} must be a real directory: ${path}`);
	return true;
}

async function writeSyncedFile(path: string, content: string): Promise<void> {
	let handle;
	try {
		handle = await open(path, "wx", 0o600);
		await handle.writeFile(content, "utf8");
		await handle.sync();
	} finally {
		await handle?.close();
	}
}

export class AfkLock {
	private readonly token: string;
	private readonly home: string;
	private readonly path: string;
	private readonly lockDir: string;
	private readonly ownerPath: string;
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
		this.ownerPath = join(this.path, OWNER_FILE);
		this.pid = options.pid ?? process.pid;
		this.cwd = options.cwd ?? process.cwd();
		this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
		this.invalidLockStaleMs = options.invalidLockStaleMs ?? DEFAULT_INVALID_LOCK_STALE_MS;
	}

	async acquire(): Promise<LockAcquireResult> {
		await this.ensureLockDir();

		for (;;) {
			const owner: LockOwner = { pid: this.pid, createdAt: Date.now(), cwd: this.cwd };
			const publishResult = await this.tryCreateLockDirectory(owner);
			if (publishResult === "published") {
				this.acquiredOwner = owner;
				return { ok: true };
			}

			const existing = await this.readExistingLock(this.path);
			if (!existing) continue;

			if (!existing.owner) {
				if (!(await this.isInvalidLockStale(this.path))) {
					return { ok: false, reason: "lock owner metadata is invalid and fresh" };
				}
				if (await this.claimAndRemoveStaleLock(existing)) continue;
				return { ok: false, reason: "lock changed during invalid cleanup" };
			}

			if (this.isProcessAlive(existing.owner.pid)) {
				return { ok: false, owner: existing.owner, reason: "owner process is alive" };
			}

			if (await this.claimAndRemoveStaleLock(existing)) continue;
			const changed = await this.readExistingLock(this.path);
			if (changed?.owner) return { ok: false, owner: changed.owner, reason: "lock changed during stale cleanup" };
			return { ok: false, reason: "lock changed during stale cleanup" };
		}
	}

	async release(): Promise<void> {
		if (!this.acquiredOwner) return;
		const claimPath = await this.claimLockDirectory("release");
		if (!claimPath) {
			this.acquiredOwner = undefined;
			return;
		}

		const claimed = await this.readExistingLock(claimPath);
		if (claimed?.owner && sameOwner(claimed.owner, this.acquiredOwner)) {
			await rm(claimPath, { recursive: true, force: true });
			await fsyncDirectory(this.lockDir);
		} else {
			await this.restoreClaimedLock(claimPath);
		}
		this.acquiredOwner = undefined;
	}

	private async ensureLockDir(): Promise<void> {
		const homeExists = await validateExistingDirectory(this.home, "AFK home");
		if (!homeExists) await mkdir(this.home, { recursive: true, mode: 0o700 });
		await chmod(this.home, 0o700);

		try {
			await mkdir(this.lockDir, { mode: 0o700 });
			await fsyncDirectory(this.home);
		} catch (error) {
			if (!hasErrorCode(error, "EEXIST")) throw error;
		}

		await validateExistingDirectory(this.lockDir, "lock directory");
		await chmod(this.lockDir, 0o700);
		await fsyncDirectory(this.lockDir);
	}

	private async tryCreateLockDirectory(owner: LockOwner): Promise<"published" | "exists"> {
		try {
			await mkdir(this.path, { mode: 0o700 });
		} catch (error) {
			if (hasErrorCode(error, "EEXIST")) return "exists";
			throw error;
		}

		try {
			await writeSyncedFile(this.ownerPath, `${JSON.stringify(owner)}\n`);
			await fsyncDirectory(this.path);
			await fsyncDirectory(this.lockDir);
			return "published";
		} catch (error) {
			await rm(this.path, { recursive: true, force: true });
			await fsyncDirectory(this.lockDir);
			throw error;
		}
	}

	private async readExistingLock(path: string): Promise<{ raw: string | undefined; owner: LockOwner | undefined } | undefined> {
		let info;
		try {
			info = await lstat(path);
		} catch (error) {
			if (hasErrorCode(error, "ENOENT")) return undefined;
			throw error;
		}

		if (info.isSymbolicLink() || !info.isDirectory()) {
			throw new Error(`lock path exists but is not a directory: ${path}`);
		}

		try {
			const raw = await readFile(join(path, OWNER_FILE), "utf8");
			return { raw, owner: parseLockOwner(raw) };
		} catch (error) {
			if (hasErrorCode(error, "ENOENT")) return { raw: undefined, owner: undefined };
			throw error;
		}
	}

	private async isInvalidLockStale(path: string): Promise<boolean> {
		try {
			const directoryInfo = await stat(path);
			let newestMetadataMtime = directoryInfo.mtimeMs;
			try {
				const ownerInfo = await stat(join(path, OWNER_FILE));
				newestMetadataMtime = Math.max(newestMetadataMtime, ownerInfo.mtimeMs);
			} catch (error) {
				if (!hasErrorCode(error, "ENOENT")) throw error;
			}
			return Date.now() - newestMetadataMtime > this.invalidLockStaleMs;
		} catch (error) {
			if (hasErrorCode(error, "ENOENT")) return false;
			throw error;
		}
	}

	private async claimAndRemoveStaleLock(expected: { raw: string | undefined; owner: LockOwner | undefined }): Promise<boolean> {
		const claimPath = await this.claimLockDirectory("stale");
		if (!claimPath) return false;

		const claimed = await this.readExistingLock(claimPath);
		if (!claimed || !this.sameLockMetadata(claimed, expected)) {
			await this.restoreClaimedLock(claimPath);
			return false;
		}

		await rm(claimPath, { recursive: true, force: true });
		await fsyncDirectory(this.lockDir);
		return true;
	}

	private async claimLockDirectory(reason: "release" | "stale"): Promise<string | undefined> {
		const claimPath = join(this.lockDir, `.${basename(this.path)}.${process.pid}.${randomUUID()}.${reason}`);
		try {
			await rename(this.path, claimPath);
			await fsyncDirectory(this.lockDir);
			return claimPath;
		} catch (error) {
			if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "EEXIST")) return undefined;
			throw error;
		}
	}

	private async restoreClaimedLock(claimPath: string): Promise<void> {
		try {
			await rename(claimPath, this.path);
			await fsyncDirectory(this.lockDir);
		} catch (error) {
			if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "EEXIST")) return;
			throw error;
		}
	}

	private sameLockMetadata(
		left: { raw: string | undefined; owner: LockOwner | undefined },
		right: { raw: string | undefined; owner: LockOwner | undefined },
	): boolean {
		if (left.raw !== right.raw) return false;
		if (!left.owner && !right.owner) return true;
		if (!left.owner || !right.owner) return false;
		return sameOwner(left.owner, right.owner);
	}
}

import { createHash } from "node:crypto";
import { chmod, mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

export interface LockOwner {
	pid: number;
	createdAt: string;
	cwd: string;
}

export type LockAcquireResult = { ok: true } | { ok: false; owner: LockOwner; reason: string };

export interface AfkLockOptions {
	token: string;
	home: string;
	pid?: number;
	cwd?: string;
	isProcessAlive?: (pid: number) => boolean;
}

export function lockPathForToken(token: string, home: string): string {
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
		if (typeof candidate.createdAt !== "string" || candidate.createdAt.length === 0) return undefined;
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

export class AfkLock {
	private readonly path: string;
	private readonly lockDir: string;
	private readonly pid: number;
	private readonly cwd: string;
	private readonly isProcessAlive: (pid: number) => boolean;
	private acquiredOwner: LockOwner | undefined;

	constructor(options: AfkLockOptions) {
		this.path = lockPathForToken(options.token, options.home);
		this.lockDir = join(options.home, "locks");
		this.pid = options.pid ?? process.pid;
		this.cwd = options.cwd ?? process.cwd();
		this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
	}

	async acquire(): Promise<LockAcquireResult> {
		await mkdir(this.lockDir, { recursive: true, mode: 0o700 });
		await chmod(this.lockDir, 0o700);

		for (;;) {
			const owner: LockOwner = { pid: this.pid, createdAt: new Date().toISOString(), cwd: this.cwd };
			let handle;
			try {
				handle = await open(this.path, "wx", 0o600);
				await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
				await handle.sync();
				this.acquiredOwner = owner;
				return { ok: true };
			} catch (error) {
				if (!hasErrorCode(error, "EEXIST")) throw error;
			} finally {
				await handle?.close();
			}

			const existingOwner = await this.readExistingOwner();
			if (existingOwner && this.isProcessAlive(existingOwner.pid)) {
				return { ok: false, owner: existingOwner, reason: "owner process is alive" };
			}

			await rm(this.path, { force: true });
		}
	}

	async release(): Promise<void> {
		if (!this.acquiredOwner) return;
		const owner = await this.readExistingOwner();
		if (owner && sameOwner(owner, this.acquiredOwner)) await rm(this.path, { force: true });
		this.acquiredOwner = undefined;
	}

	private async readExistingOwner(): Promise<LockOwner | undefined> {
		try {
			return parseLockOwner(await readFile(this.path, "utf8"));
		} catch (error) {
			if (hasErrorCode(error, "ENOENT")) return undefined;
			throw error;
		}
	}
}

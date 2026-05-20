import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AfkConfig } from "./types.ts";

export function getAfkHome(env: NodeJS.ProcessEnv = process.env): string {
	const afkHome = env.PI_AFK_HOME?.trim();
	if (afkHome) return afkHome;
	const home = env.HOME?.trim() || homedir();
	return join(home, ".pi", "agent", "afk");
}

export function configPath(home = getAfkHome()): string {
	return join(home, "config.json");
}

export function isAfkConfig(value: unknown): value is AfkConfig {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.botToken === "string" &&
		candidate.botToken.trim().length > 0 &&
		typeof candidate.botUsername === "string" &&
		candidate.botUsername.trim().length > 0 &&
		typeof candidate.chatId === "number" &&
		Number.isSafeInteger(candidate.chatId) &&
		candidate.chatId > 0 &&
		typeof candidate.userId === "number" &&
		Number.isSafeInteger(candidate.userId) &&
		candidate.userId > 0
	);
}

function cleanConfig(config: AfkConfig): AfkConfig {
	return {
		botToken: config.botToken,
		botUsername: config.botUsername,
		chatId: config.chatId,
		userId: config.userId,
	};
}

function hasErrorCode(error: unknown, code: string): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function isAfkOwnedEntry(entry: string): boolean {
	return entry === "config.json" || entry === "locks" || /^\.config\.json\..+\.tmp$/.test(entry);
}

async function validateExistingAfkHome(home: string): Promise<boolean> {
	let stats;
	try {
		stats = await lstat(home);
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return false;
		throw error;
	}

	if (stats.isSymbolicLink()) throw new Error(`Unsafe AFK home: ${home} is a symlink`);
	if (!stats.isDirectory()) throw new Error(`Unsafe AFK home: ${home} is not a directory`);

	const entries = await readdir(home);
	const unrelatedEntry = entries.find((entry) => !isAfkOwnedEntry(entry));
	if (unrelatedEntry) throw new Error(`Unsafe AFK home: contains unrelated entry ${unrelatedEntry}`);
	return true;
}

async function prepareAfkHomeForWrite(home: string): Promise<void> {
	const exists = await validateExistingAfkHome(home);
	if (!exists) await mkdir(home, { recursive: true, mode: 0o700 });
	await chmod(home, 0o700);
}

export async function readConfig(home = getAfkHome()): Promise<AfkConfig | undefined> {
	const exists = await validateExistingAfkHome(home);
	if (!exists) return undefined;

	let raw;
	try {
		raw = await readFile(configPath(home), "utf8");
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return undefined;
		throw error;
	}

	await chmod(home, 0o700);
	await chmod(configPath(home), 0o600);

	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!isAfkConfig(parsed)) return undefined;
		return cleanConfig(parsed);
	} catch (error) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
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

export async function writeConfig(config: AfkConfig, home = getAfkHome()): Promise<void> {
	if (!isAfkConfig(config)) throw new Error("Invalid AFK config: refusing to write config.json");

	await prepareAfkHomeForWrite(home);

	const targetPath = configPath(home);
	const tempPath = join(home, `.config.json.${process.pid}.${randomUUID()}.tmp`);
	let handle;

	try {
		handle = await open(tempPath, "wx", 0o600);
		await handle.writeFile(`${JSON.stringify(cleanConfig(config), null, 2)}\n`, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		await chmod(tempPath, 0o600);
		await rename(tempPath, targetPath);
		await chmod(targetPath, 0o600);
		await fsyncDirectory(home);
	} catch (error) {
		try {
			await handle?.close();
		} finally {
			await rm(tempPath, { force: true });
		}
		throw error;
	}
}

export function redactConfig(config: AfkConfig): Omit<AfkConfig, "botToken"> & { botToken: "<redacted>" } {
	return { ...cleanConfig(config), botToken: "<redacted>" };
}

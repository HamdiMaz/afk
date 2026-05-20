import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AfkConfig } from "./types.ts";

export function getAfkHome(env: NodeJS.ProcessEnv = process.env): string {
	if (env.PI_AFK_HOME?.trim()) return env.PI_AFK_HOME;
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
		candidate.botToken.length > 0 &&
		typeof candidate.botUsername === "string" &&
		candidate.botUsername.length > 0 &&
		typeof candidate.chatId === "number" &&
		Number.isSafeInteger(candidate.chatId) &&
		typeof candidate.userId === "number" &&
		Number.isSafeInteger(candidate.userId)
	);
}

export async function readConfig(home = getAfkHome()): Promise<AfkConfig | undefined> {
	try {
		const raw = await readFile(configPath(home), "utf8");
		const parsed = JSON.parse(raw) as unknown;
		return isAfkConfig(parsed) ? parsed : undefined;
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
}

export async function writeConfig(config: AfkConfig, home = getAfkHome()): Promise<void> {
	await mkdir(home, { recursive: true, mode: 0o700 });
	await chmod(home, 0o700);

	const targetPath = configPath(home);
	const tempPath = join(home, `.config.json.${process.pid}.${randomUUID()}.tmp`);

	try {
		await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
		await chmod(tempPath, 0o600);
		await rename(tempPath, targetPath);
		await chmod(targetPath, 0o600);
	} catch (error) {
		await rm(tempPath, { force: true });
		throw error;
	}
}

export function redactConfig(config: AfkConfig): Omit<AfkConfig, "botToken"> & { botToken: "<redacted>" } {
	return { ...config, botToken: "<redacted>" };
}

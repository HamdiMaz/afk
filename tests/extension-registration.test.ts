import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import setupExtension from "../extensions/index.ts";
import { AfkOptionSchema, AfkQuestionSchema } from "../extensions/types.ts";

interface RegisteredCommandStub {
	name: string;
	options: unknown;
}

interface RegisteredEventStub {
	name: string;
	handler: unknown;
}

interface RegisteredToolStub {
	name: string;
	label: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	execute: (...args: unknown[]) => Promise<unknown>;
	renderCall: (...args: unknown[]) => unknown;
	renderResult: (...args: unknown[]) => unknown;
}

const tempHomes: string[] = [];

async function tempHome(): Promise<string> {
	const home = await mkdtemp(join(tmpdir(), "pi-afk-extension-"));
	tempHomes.push(home);
	return home;
}

const withEnv = async (env: Record<string, string | undefined>, callback: () => Promise<void>): Promise<void> => {
	const previous = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
	try {
		for (const [key, value] of Object.entries(env)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await callback();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
};

const fakeExtensionCtx = () => {
	const statuses: Array<{ key: string; text: string | undefined }> = [];
	const notifications: Array<{ message: string; type?: "info" | "warning" | "error" }> = [];
	return {
		statuses,
		notifications,
		ctx: {
			hasUI: true,
			ui: {
				notify(message: string, type?: "info" | "warning" | "error") {
					notifications.push(type === undefined ? { message } : { message, type });
				},
				setStatus(key: string, text: string | undefined) {
					statuses.push({ key, text });
				},
			},
		} as unknown as ExtensionContext,
	};
};

afterEach(async () => {
	await Promise.all(tempHomes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

function createPiStub() {
	const registeredTools: RegisteredToolStub[] = [];
	const registeredCommands: RegisteredCommandStub[] = [];
	const registeredEvents: RegisteredEventStub[] = [];
	const pi = {
		registerTool(tool: RegisteredToolStub) {
			registeredTools.push(tool);
		},
		registerCommand(name: string, options: unknown) {
			registeredCommands.push({ name, options });
		},
		on(name: string, handler: unknown) {
			registeredEvents.push({ name, handler });
		},
	};

	return { pi: pi as unknown as ExtensionAPI, registeredTools, registeredCommands, registeredEvents };
}

describe("extension registration", () => {
	it("registers the afk tool, commands, and lifecycle events", () => {
		const { pi, registeredTools, registeredCommands, registeredEvents } = createPiStub();

		assert.equal(typeof setupExtension, "function");
		assert.doesNotThrow(() => setupExtension(pi));

		assert.deepEqual(
			registeredTools.map((tool) => tool.name),
			["afk"],
		);
		assert.equal(registeredTools[0]?.label, "AFK");
		assert.match(registeredTools[0]?.description ?? "", /Telegram/i);
		assert.match(registeredTools[0]?.promptSnippet ?? "", /afk/i);
		assert.match(registeredTools[0]?.promptGuidelines?.join("\n") ?? "", /Telegram|AFK/i);
		assert.deepEqual(
			registeredCommands.map((command) => command.name),
			["afk", "afk-settings"],
		);
		assert.deepEqual(
			registeredEvents.map((event) => event.name),
			["before_agent_start", "session_shutdown"],
		);
	});

	it("renderCall and renderResult return components for notify, ask, and result details", () => {
		const { pi, registeredTools } = createPiStub();
		setupExtension(pi);
		const tool = registeredTools[0];
		assert.ok(tool);

		assert.equal(typeof tool.renderCall({ mode: "notify", message: "Ping" }), "object");
		assert.equal(typeof tool.renderCall({ mode: "ask", questions: [] }), "object");
		assert.equal(
			typeof tool.renderResult({ content: [], details: { mode: "notify", sent: true } }),
			"object",
		);
		assert.equal(
			typeof tool.renderResult({ content: [], details: { mode: "ask", answers: [] } }),
			"object",
		);
		assert.equal(
			typeof tool.renderResult({ content: [], details: { mode: "error", reason: "bad" } }),
			"object",
		);
	});

	it("before_agent_start returns no guidance before AFK is enabled", async () => {
		await withEnv({ PI_AFK_HOME: await tempHome() }, async () => {
			const { pi, registeredEvents } = createPiStub();
			setupExtension(pi);
			const event = registeredEvents.find(({ name }) => name === "before_agent_start");
			assert.ok(event);

			const result = (event.handler as (payload: { systemPrompt: string }) => unknown)({ systemPrompt: "base" });

			assert.equal(result, undefined);
		});
	});

	it("session_shutdown handler is callable and clears AFK status", async () => {
		await withEnv({ PI_AFK_HOME: await tempHome() }, async () => {
			const { pi, registeredEvents } = createPiStub();
			setupExtension(pi);
			const event = registeredEvents.find(({ name }) => name === "session_shutdown");
			assert.ok(event);
			const { ctx, statuses } = fakeExtensionCtx();

			await (event.handler as (payload: { reason: string }, ctx: ExtensionContext) => Promise<void>)({ reason: "test" }, ctx);

			assert.deepEqual(statuses, [{ key: "afk", text: undefined }]);
		});
	});

	it("requires non-empty AFK question and option fields", () => {
		const questionProperties = AfkQuestionSchema.properties as unknown as Record<string, Record<string, unknown>>;
		const optionProperties = AfkOptionSchema.properties as unknown as Record<string, Record<string, unknown>>;

		assert.equal(questionProperties.id?.minLength, 1);
		assert.equal(questionProperties.question?.minLength, 1);
		assert.equal(questionProperties.options?.minItems, 1);
		assert.equal(optionProperties.label?.minLength, 1);
		assert.equal(optionProperties.value?.minLength, 1);
	});

	it("executes the registered afk tool with disabled details before AFK is enabled", async () => {
		const { pi, registeredTools } = createPiStub();
		setupExtension(pi);

		const result = await registeredTools[0]?.execute(
			"tool-call-id",
			{ mode: "notify", message: "Ping" },
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		assert.deepEqual(result, {
			content: [{ type: "text", text: "AFK mode is off. Continue normally and ask the user locally if needed." }],
			details: { mode: "disabled", reason: "AFK mode is off" },
		});
	});
});

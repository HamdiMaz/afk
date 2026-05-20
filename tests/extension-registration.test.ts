import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import setupExtension from "../extensions/index.ts";

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
}

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

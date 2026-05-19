import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import setupExtension from "../extensions/index.ts";

describe("extension scaffold", () => {
	it("exports a loadable Pi extension factory without registering runtime resources yet", () => {
		const registeredTools: unknown[] = [];
		const registeredCommands: string[] = [];
		const registeredEvents: string[] = [];
		const pi = {
			registerTool(tool: unknown) {
				registeredTools.push(tool);
			},
			registerCommand(name: string) {
				registeredCommands.push(name);
			},
			on(event: string) {
				registeredEvents.push(event);
			},
		};

		assert.equal(typeof setupExtension, "function");
		assert.doesNotThrow(() => setupExtension(pi as unknown as ExtensionAPI));
		assert.deepEqual(registeredTools, []);
		assert.deepEqual(registeredCommands, []);
		assert.deepEqual(registeredEvents, []);
	});
});

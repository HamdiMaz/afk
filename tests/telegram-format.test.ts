import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCallbackData, buildQuestionPayload, parseCallbackData } from "../extensions/telegram-format.ts";
import type { ActiveTelegramQuestion } from "../extensions/ask-queue.ts";

const activeQuestion = (): ActiveTelegramQuestion => ({
	requestId: "request-1",
	nonce: "abc123",
	questionIndex: 1,
	totalQuestions: 3,
	question: {
		id: "deploy",
		question: "Deploy now?",
		options: [
			{ label: "Ship it", value: "ship", description: "Deploy to production", recommended: true },
			{ label: "Wait", value: "wait", description: "Hold until morning" },
			{ label: "Investigate", value: "investigate" },
		],
	},
});

describe("telegram formatting", () => {
	it("builds callback data with the afk prefix, nonce, and option index", () => {
		assert.equal(buildCallbackData("abc123", 2), "afk:abc123:2");
	});

	it("parses valid callback data", () => {
		assert.deepEqual(parseCallbackData("afk:abc123:2"), { nonce: "abc123", optionIndex: 2 });
	});

	it("returns undefined for invalid callback data", () => {
		assert.equal(parseCallbackData("other:abc123:2"), undefined);
		assert.equal(parseCallbackData("afk:abc123:not-a-number"), undefined);
		assert.equal(parseCallbackData("afk:abc123:-1"), undefined);
		assert.equal(parseCallbackData("afk:abc123:1.5"), undefined);
		assert.equal(parseCallbackData("afk::1"), undefined);
		assert.equal(parseCallbackData("afk:abc123:1:extra"), undefined);
	});

	it("formats question text with progress, options, descriptions, and custom text hint", () => {
		const payload = buildQuestionPayload(activeQuestion());

		assert.match(payload.text, /Question 2\/3/);
		assert.match(payload.text, /Deploy now\?/);
		assert.match(payload.text, /1\. Ship it — Deploy to production/);
		assert.match(payload.text, /2\. Wait — Hold until morning/);
		assert.match(payload.text, /3\. Investigate/);
		assert.match(payload.text, /custom text/i);
	});

	it("builds one button row per option with recommended prefix and callback data", () => {
		const payload = buildQuestionPayload(activeQuestion());

		assert.deepEqual(payload.buttons, [
			[{ text: "⭐ Ship it", callbackData: "afk:abc123:0" }],
			[{ text: "Wait", callbackData: "afk:abc123:1" }],
			[{ text: "Investigate", callbackData: "afk:abc123:2" }],
		]);
	});
});

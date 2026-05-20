import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AfkAskCancelledError, AskQueue, type ActiveTelegramQuestion, type AskQueueTransport } from "../extensions/ask-queue.ts";
import type { AfkQuestion } from "../extensions/types.ts";

const question = (id: string, text = `Question ${id}`): AfkQuestion => ({
	id,
	question: text,
	options: [
		{ label: "Yes", value: "yes", recommended: true },
		{ label: "No", value: "no" },
	],
});

class FakeTransport implements AskQueueTransport {
	readonly sent: ActiveTelegramQuestion[] = [];
	readonly cancellations: string[] = [];

	async sendQuestion(active: ActiveTelegramQuestion): Promise<void> {
		this.sent.push(active);
	}

	async sendCancellation(reason: string): Promise<void> {
		this.cancellations.push(reason);
	}
}

describe("AskQueue", () => {
	it("resolves a button answer", async () => {
		const transport = new FakeTransport();
		const queue = new AskQueue(transport, { makeNonce: () => "n1" });

		const resultPromise = queue.enqueue([question("q1")]);
		assert.equal(queue.hasPendingQuestion, true);
		assert.equal(transport.sent.length, 1);
		assert.deepEqual(
			{
				nonce: transport.sent[0]?.nonce,
				questionIndex: transport.sent[0]?.questionIndex,
				totalQuestions: transport.sent[0]?.totalQuestions,
				question: transport.sent[0]?.question,
			},
			{ nonce: "n1", questionIndex: 0, totalQuestions: 1, question: question("q1") },
		);
		assert.equal(typeof transport.sent[0]?.requestId, "string");
		assert.notEqual(transport.sent[0]?.requestId.length, 0);
		assert.equal(await queue.answerWithOption("n1", 0), true);

		assert.deepEqual(await resultPromise, [{ id: "q1", value: "yes", label: "Yes", wasCustom: false }]);
		assert.equal(queue.hasPendingQuestion, false);
	});

	it("resolves a custom text answer", async () => {
		const transport = new FakeTransport();
		const queue = new AskQueue(transport, { makeNonce: () => "n1" });

		const resultPromise = queue.enqueue([question("q1")]);
		assert.equal(await queue.answerWithText("  Use the simple path  "), true);

		assert.deepEqual(await resultPromise, [
			{ id: "q1", value: "Use the simple path", label: "Use the simple path", wasCustom: true },
		]);
	});

	it("asks multiple questions one at a time", async () => {
		const transport = new FakeTransport();
		const nonces = ["n1", "n2"];
		const queue = new AskQueue(transport, { makeNonce: () => nonces.shift() ?? "missing" });

		const resultPromise = queue.enqueue([question("q1"), question("q2")]);
		assert.equal(transport.sent.length, 1);
		assert.equal(transport.sent[0]?.question.id, "q1");
		assert.equal(transport.sent[0]?.questionIndex, 0);
		assert.equal(transport.sent[0]?.totalQuestions, 2);

		assert.equal(await queue.answerWithOption("n1", 1), true);
		assert.equal(transport.sent.length, 2);
		assert.equal(transport.sent[1]?.question.id, "q2");
		assert.equal(transport.sent[1]?.questionIndex, 1);
		assert.equal(transport.sent[1]?.totalQuestions, 2);

		assert.equal(await queue.answerWithText("custom q2"), true);
		assert.deepEqual(await resultPromise, [
			{ id: "q1", value: "no", label: "No", wasCustom: false },
			{ id: "q2", value: "custom q2", label: "custom q2", wasCustom: true },
		]);
	});

	it("queues overlapping asks", async () => {
		const transport = new FakeTransport();
		const nonces = ["n1", "n2"];
		const queue = new AskQueue(transport, { makeNonce: () => nonces.shift() ?? "missing" });

		const first = queue.enqueue([question("first")]);
		const second = queue.enqueue([question("second")]);
		assert.equal(transport.sent.length, 1);
		assert.equal(transport.sent[0]?.question.id, "first");

		assert.equal(await queue.answerWithOption("n1", 0), true);
		assert.deepEqual(await first, [{ id: "first", value: "yes", label: "Yes", wasCustom: false }]);
		assert.equal(transport.sent.length, 2);
		assert.equal(transport.sent[1]?.question.id, "second");

		assert.equal(await queue.answerWithOption("n2", 1), true);
		assert.deepEqual(await second, [{ id: "second", value: "no", label: "No", wasCustom: false }]);
	});

	it("ignores stale button nonces", async () => {
		const transport = new FakeTransport();
		const queue = new AskQueue(transport, { makeNonce: () => "active" });
		void queue.enqueue([question("q1")]);

		assert.equal(await queue.answerWithOption("old", 0), false);
		assert.equal(queue.hasPendingQuestion, true);
	});

	it("cancels active and queued asks", async () => {
		const transport = new FakeTransport();
		const queue = new AskQueue(transport, { makeNonce: () => "n1" });

		const first = queue.enqueue([question("first")]);
		const second = queue.enqueue([question("second")]);
		queue.cancelAll("AFK disabled");

		await assert.rejects(first, AfkAskCancelledError);
		await assert.rejects(second, AfkAskCancelledError);
		assert.deepEqual(transport.cancellations, ["AFK disabled"]);
		assert.equal(queue.hasPendingQuestion, false);
	});

	it("rejects empty question lists", async () => {
		const queue = new AskQueue(new FakeTransport());

		await assert.rejects(() => queue.enqueue([]), /at least one question/i);
	});

	it("ignores blank custom text", async () => {
		const transport = new FakeTransport();
		const queue = new AskQueue(transport, { makeNonce: () => "n1" });
		const resultPromise = queue.enqueue([question("q1")]);

		assert.equal(await queue.answerWithText("  \t\n  "), false);
		assert.equal(queue.hasPendingQuestion, true);
		assert.equal(await queue.answerWithOption("n1", 0), true);
		assert.deepEqual(await resultPromise, [{ id: "q1", value: "yes", label: "Yes", wasCustom: false }]);
	});

	it("ignores invalid option indexes", async () => {
		const transport = new FakeTransport();
		const queue = new AskQueue(transport, { makeNonce: () => "n1" });
		const resultPromise = queue.enqueue([question("q1")]);

		assert.equal(await queue.answerWithOption("n1", 99), false);
		assert.equal(queue.hasPendingQuestion, true);
		assert.equal(await queue.answerWithOption("n1", 1), true);
		assert.deepEqual(await resultPromise, [{ id: "q1", value: "no", label: "No", wasCustom: false }]);
	});

	it("cancels an active ask when its abort signal fires", async () => {
		const transport = new FakeTransport();
		const queue = new AskQueue(transport, { makeNonce: () => "n1" });
		const controller = new AbortController();

		const resultPromise = queue.enqueue([question("q1")], controller.signal);
		controller.abort();

		await assert.rejects(resultPromise, AfkAskCancelledError);
		assert.deepEqual(transport.cancellations, ["AFK ask was aborted"]);
		assert.equal(queue.hasPendingQuestion, false);
	});
});

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
	sendQuestionFailures: Array<Error | undefined> = [];
	sendCancellationFailure: Error | undefined;

	async sendQuestion(active: ActiveTelegramQuestion): Promise<void> {
		this.sent.push(active);
		const failure = this.sendQuestionFailures.shift();
		if (failure) throw failure;
	}

	async sendCancellation(reason: string): Promise<void> {
		this.cancellations.push(reason);
		if (this.sendCancellationFailure) throw this.sendCancellationFailure;
	}
}

const rejectsSoon = async (promise: Promise<unknown>, expected: RegExp | typeof Error): Promise<void> => {
	await assert.rejects(
		Promise.race([
			promise,
			new Promise((_, reject) => setTimeout(() => reject(new Error("Promise did not reject")), 50)),
		]),
		expected,
	);
};

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

	it("rejects an ask when sending its first question fails and continues with the next ask", async () => {
		const transport = new FakeTransport();
		transport.sendQuestionFailures.push(new Error("telegram down"));
		const nonces = ["n1", "n2"];
		const queue = new AskQueue(transport, { makeNonce: () => nonces.shift() ?? "missing" });

		const failed = queue.enqueue([question("failed")]);
		const next = queue.enqueue([question("next")]);

		await rejectsSoon(failed, /telegram down/);
		assert.equal(queue.hasPendingQuestion, true);
		assert.equal(transport.sent.length, 2);
		assert.equal(transport.sent[1]?.question.id, "next");

		assert.equal(await queue.answerWithOption("n2", 0), true);
		assert.deepEqual(await next, [{ id: "next", value: "yes", label: "Yes", wasCustom: false }]);
		assert.equal(queue.hasPendingQuestion, false);
	});

	it("rejects an active ask when sending a later question fails and continues with the next ask", async () => {
		const transport = new FakeTransport();
		transport.sendQuestionFailures.push(undefined, new Error("second send failed"));
		const nonces = ["n1", "n2", "n3"];
		const queue = new AskQueue(transport, { makeNonce: () => nonces.shift() ?? "missing" });

		const failed = queue.enqueue([question("first"), question("second")]);
		const next = queue.enqueue([question("next")]);

		assert.equal(await queue.answerWithOption("n1", 0), true);
		await rejectsSoon(failed, /second send failed/);
		assert.equal(queue.hasPendingQuestion, true);
		assert.equal(transport.sent.length, 3);
		assert.equal(transport.sent[2]?.question.id, "next");

		assert.equal(await queue.answerWithOption("n3", 1), true);
		assert.deepEqual(await next, [{ id: "next", value: "no", label: "No", wasCustom: false }]);
	});

	it("rejects a queued ask when its abort signal fires without affecting the active ask", async () => {
		const transport = new FakeTransport();
		const nonces = ["n1", "n2"];
		const queue = new AskQueue(transport, { makeNonce: () => nonces.shift() ?? "missing" });
		const controller = new AbortController();

		const active = queue.enqueue([question("active")]);
		const queued = queue.enqueue([question("queued")], controller.signal);
		controller.abort();

		await assert.rejects(queued, AfkAskCancelledError);
		assert.equal(queue.hasPendingQuestion, true);
		assert.deepEqual(transport.cancellations, []);
		assert.equal(await queue.answerWithOption("n1", 0), true);
		assert.deepEqual(await active, [{ id: "active", value: "yes", label: "Yes", wasCustom: false }]);
		assert.equal(queue.hasPendingQuestion, false);
	});

	it("rejects asks even when cancellation transport fails", async () => {
		const transport = new FakeTransport();
		transport.sendCancellationFailure = new Error("cancel send failed");
		const queue = new AskQueue(transport, { makeNonce: () => "n1" });

		const first = queue.enqueue([question("first")]);
		const second = queue.enqueue([question("second")]);
		queue.cancelAll("AFK disabled");

		await assert.rejects(first, AfkAskCancelledError);
		await assert.rejects(second, AfkAskCancelledError);
		assert.deepEqual(transport.cancellations, ["AFK disabled"]);
		assert.equal(queue.hasPendingQuestion, false);
	});

	it("uses the questions snapshot from enqueue time for queued asks", async () => {
		const transport = new FakeTransport();
		const nonces = ["n1", "n2"];
		const queue = new AskQueue(transport, { makeNonce: () => nonces.shift() ?? "missing" });
		const queuedQuestions = [question("queued")];

		const active = queue.enqueue([question("active")]);
		const queued = queue.enqueue(queuedQuestions);
		queuedQuestions[0] = question("mutated");

		assert.equal(await queue.answerWithOption("n1", 0), true);
		await active;
		assert.equal(transport.sent[1]?.question.id, "queued");

		assert.equal(await queue.answerWithOption("n2", 0), true);
		assert.deepEqual(await queued, [{ id: "queued", value: "yes", label: "Yes", wasCustom: false }]);
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

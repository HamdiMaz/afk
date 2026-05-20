import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ActiveTelegramQuestion } from "../extensions/ask-queue.ts";
import { TelegramBridge } from "../extensions/telegram.ts";

interface FakeTelegramContext {
	chat: { id: number; type?: string };
	from: { id: number };
	message: { text: string };
	callbackQuery: { id: string; data: string; message?: { chat: { id: number } } };
}

class FakeBot {
	readonly handlers = new Map<string, (ctx: unknown) => Promise<void> | void>();
	readonly sentMessages: Array<{ chatId: number; text: string; options?: unknown }> = [];
	readonly answeredCallbacks: Array<{ callbackQueryId: string; options?: unknown }> = [];
	initCalls = 0;
	startCalls = 0;
	stopCalls = 0;
	initError: Error | undefined;
	catchHandler: ((error: unknown) => void) | undefined;
	api = {
		getMe: async () => ({ username: "afk_bot", first_name: "AFK" }),
		sendMessage: async (chatId: number, text: string, options?: unknown) => {
			this.sentMessages.push({ chatId, text, options });
		},
		answerCallbackQuery: async (callbackQueryId: string, options?: unknown) => {
			this.answeredCallbacks.push({ callbackQueryId, options });
		},
	};

	on(event: "message:text" | "callback_query:data", handler: (ctx: FakeTelegramContext) => Promise<void> | void): void {
		this.handlers.set(event, (ctx: unknown) => handler(ctx as FakeTelegramContext));
	}

	catch(handler: (error: unknown) => void): void {
		this.catchHandler = handler;
	}

	async init(): Promise<void> {
		this.initCalls += 1;
		if (this.initError) throw this.initError;
	}

	start(): Promise<void> {
		this.startCalls += 1;
		return new Promise(() => undefined);
	}

	stop(): void {
		this.stopCalls += 1;
	}
}

const activeQuestion = (): ActiveTelegramQuestion => ({
	requestId: "request-1",
	nonce: "abc123",
	questionIndex: 0,
	totalQuestions: 1,
	question: {
		id: "deploy",
		question: "Deploy now?",
		options: [
			{ label: "Ship it", value: "ship", recommended: true },
			{ label: "Wait", value: "wait" },
		],
	},
});

describe("TelegramBridge", () => {
	it("registers text middleware and forwards text messages to onText", async () => {
		const fakeBot = new FakeBot();
		let received: unknown;
		new TelegramBridge("test-token", {
			onText: (message) => {
				received = message;
			},
		}, fakeBot);

		const handler = fakeBot.handlers.get("message:text");
		assert.equal(typeof handler, "function");
		await handler?.({
			chat: { id: 123, type: "private" },
			from: { id: 456 },
			message: { text: "hello" },
		});

		assert.deepEqual(received, { chatId: 123, userId: 456, text: "hello", isPrivate: true });
	});

	it("registers callback middleware and forwards callback query data to onCallback", async () => {
		const fakeBot = new FakeBot();
		let received: unknown;
		new TelegramBridge("test-token", {
			onText: () => undefined,
			onCallback: (callback) => {
				received = callback;
			},
		}, fakeBot);

		const handler = fakeBot.handlers.get("callback_query:data");
		assert.equal(typeof handler, "function");
		await handler?.({
			from: { id: 456 },
			callbackQuery: { id: "callback-1", data: "afk:abc123:0", message: { chat: { id: 123 } } },
		});

		assert.deepEqual(received, {
			callbackQueryId: "callback-1",
			chatId: 123,
			userId: 456,
			data: "afk:abc123:0",
		});
	});

	it("acknowledges callbacks without messages and does not forward them", async () => {
		const fakeBot = new FakeBot();
		let callbackCalls = 0;
		new TelegramBridge("test-token", {
			onText: () => undefined,
			onCallback: () => {
				callbackCalls += 1;
			},
		}, fakeBot);

		await fakeBot.handlers.get("callback_query:data")?.({
			from: { id: 456 },
			callbackQuery: { id: "callback-1", data: "afk:abc123:0" },
		});

		assert.equal(callbackCalls, 0);
		assert.deepEqual(fakeBot.answeredCallbacks, [{ callbackQueryId: "callback-1", options: undefined }]);
	});

	it("falls back to answering callbacks and reports callback handler rejections", async () => {
		const fakeBot = new FakeBot();
		const error = new Error("handler failed");
		let reported: unknown;
		new TelegramBridge(
			"test-token",
			{
				onText: () => undefined,
				onCallback: async () => Promise.reject(error),
				onPollingError: (caught) => {
					reported = caught;
				},
			},
			fakeBot,
		);

		await fakeBot.handlers.get("callback_query:data")?.({
			from: { id: 456 },
			callbackQuery: { id: "callback-1", data: "afk:abc123:0", message: { chat: { id: 123 } } },
		});

		assert.equal(reported, error);
		assert.deepEqual(fakeBot.answeredCallbacks, [{ callbackQueryId: "callback-1", options: undefined }]);
	});

	it("sends questions to the configured chat with an inline keyboard", async () => {
		const fakeBot = new FakeBot();
		const bridge = new TelegramBridge("test-token", { onText: () => undefined }, fakeBot);

		await bridge.sendQuestion({ chatId: 999 }, activeQuestion());

		assert.equal(fakeBot.sentMessages.length, 1);
		assert.equal(fakeBot.sentMessages[0]?.chatId, 999);
		assert.match(fakeBot.sentMessages[0]?.text ?? "", /Deploy now\?/);
		assert.ok((fakeBot.sentMessages[0]?.options as { reply_markup?: unknown } | undefined)?.reply_markup);
	});

	it("start awaits init failure and does not start polling when init fails", async () => {
		const fakeBot = new FakeBot();
		const initError = new Error("invalid token");
		fakeBot.initError = initError;
		const bridge = new TelegramBridge("test-token", { onText: () => undefined }, fakeBot);

		await assert.rejects(() => bridge.start(), /invalid token/);

		assert.equal(fakeBot.initCalls, 1);
		assert.equal(fakeBot.startCalls, 0);
	});

	it("successful start calls init and start once and remains idempotent", async () => {
		const fakeBot = new FakeBot();
		const bridge = new TelegramBridge("test-token", { onText: () => undefined }, fakeBot);

		await bridge.start();
		await bridge.start();

		assert.equal(fakeBot.initCalls, 1);
		assert.equal(fakeBot.startCalls, 1);
	});

	it("starts idempotently and stop stops polling and clears state", async () => {
		const fakeBot = new FakeBot();
		const bridge = new TelegramBridge("test-token", { onText: () => undefined }, fakeBot);

		await bridge.start();
		await bridge.start();
		bridge.stop();
		await bridge.start();

		assert.equal(fakeBot.startCalls, 2);
		assert.equal(fakeBot.stopCalls, 1);
	});
});

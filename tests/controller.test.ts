import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ActiveTelegramQuestion } from "../extensions/ask-queue.ts";
import { AfkController, toggleAfk } from "../extensions/controller.ts";
import { writeConfig } from "../extensions/config.ts";
import { buildCallbackData } from "../extensions/telegram-format.ts";
import type { TelegramBridgeHandlers, TelegramBridgePort } from "../extensions/telegram.ts";
import type { AfkConfig, AfkQuestion } from "../extensions/types.ts";

class FakeBridge implements TelegramBridgePort {
	started = false;
	stopped = false;
	readonly messages: Array<{ chatId: number; text: string }> = [];
	readonly questions: ActiveTelegramQuestion[] = [];
	readonly callbacks: Array<{ callbackQueryId: string; text?: string }> = [];

	constructor(readonly handlers: TelegramBridgeHandlers) {}

	async getMe(): Promise<{ username: string }> {
		return { username: "fake_bot" };
	}

	start(): void {
		this.started = true;
	}

	stop(): void {
		this.stopped = true;
	}

	async sendMessage(chatId: number, text: string): Promise<void> {
		this.messages.push({ chatId, text });
	}

	async sendQuestion(_config: Pick<AfkConfig, "chatId">, active: ActiveTelegramQuestion): Promise<void> {
		this.questions.push(active);
	}

	async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
		this.callbacks.push(text === undefined ? { callbackQueryId } : { callbackQueryId, text });
	}
}

class FakeLock {
	released = false;

	constructor(private readonly result: { ok: true } | { ok: false; reason: string }) {}

	async acquire(): Promise<{ ok: true } | { ok: false; reason: string }> {
		return this.result;
	}

	async release(): Promise<void> {
		this.released = true;
	}
}

async function tempHome(): Promise<string> {
	return mkdtemp(join(tmpdir(), "pi-afk-controller-"));
}

const config: AfkConfig = { botToken: "123:secret", botUsername: "fake_bot", chatId: 10, userId: 20 };

const question = (id = "decision"): AfkQuestion => ({
	id,
	question: "What should Pi do next?",
	options: [
		{ label: "Ship it", value: "ship", recommended: true },
		{ label: "Wait", value: "wait" },
	],
});

const flushAsync = async (): Promise<void> => {
	await new Promise((resolve) => setImmediate(resolve));
};

async function enabledController(): Promise<{ controller: AfkController; bridge: FakeBridge; lock: FakeLock }> {
	const home = await tempHome();
	await writeConfig(config, home);
	let bridge: FakeBridge | undefined;
	let lock: FakeLock | undefined;
	const controller = new AfkController({
		home,
		createBridge: (_token, handlers) => (bridge = new FakeBridge(handlers)),
		createLock: () => (lock = new FakeLock({ ok: true })),
	});

	assert.deepEqual(await controller.enable(), { ok: true });
	assert.ok(bridge);
	assert.ok(lock);
	return { controller, bridge, lock };
}

const fakeCommandCtx = () => {
	const notifications: Array<{ message: string; type?: "info" | "warning" | "error" }> = [];
	const statuses: Array<{ key: string; text: string | undefined }> = [];
	return {
		notifications,
		statuses,
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
		} as unknown as ExtensionCommandContext,
	};
};

describe("AfkController", () => {
	it("disabled notify returns disabled details", async () => {
		const controller = new AfkController({ home: await tempHome() });

		const result = await controller.executeTool({ mode: "notify", message: "hello" });

		assert.deepEqual(result.details, { mode: "disabled", reason: "AFK mode is off" });
		assert.match(result.content[0]?.text ?? "", /AFK mode is off/);
	});

	it("enable and disable with saved config starts and stops bridge, releases lock, and toggles guidance", async () => {
		const home = await tempHome();
		await writeConfig(config, home);
		let bridge: FakeBridge | undefined;
		let lock: FakeLock | undefined;
		const controller = new AfkController({
			home,
			createBridge: (_token, handlers) => (bridge = new FakeBridge(handlers)),
			createLock: () => (lock = new FakeLock({ ok: true })),
		});

		assert.equal(controller.promptGuidance(), undefined);
		const enabled = await controller.enable();

		assert.deepEqual(enabled, { ok: true });
		assert.equal(controller.isAfkEnabled, true);
		assert.equal(bridge?.started, true);
		assert.match(controller.promptGuidance() ?? "", /user is AFK/i);
		assert.match(controller.promptGuidance() ?? "", /afk tool/i);

		await controller.disable("AFK disabled");

		assert.equal(controller.isAfkEnabled, false);
		assert.equal(controller.promptGuidance(), undefined);
		assert.equal(bridge?.stopped, true);
		assert.equal(lock?.released, true);
	});

	it("enable fails when lock rejected", async () => {
		const home = await tempHome();
		await writeConfig(config, home);
		const controller = new AfkController({ home, createLock: () => new FakeLock({ ok: false, reason: "locked" }) });

		assert.deepEqual(await controller.enable(), { ok: false, reason: "locked" });
		assert.equal(controller.isAfkEnabled, false);
	});

	it("enable fails when Telegram is not configured", async () => {
		const controller = new AfkController({ home: await tempHome() });

		assert.deepEqual(await controller.enable(), {
			ok: false,
			reason: "Telegram is not configured. Run /afk-settings first.",
		});
	});

	it("notify sends Telegram message when enabled", async () => {
		const { controller, bridge } = await enabledController();

		const result = await controller.executeTool({ mode: "notify", message: "  Done  " });

		assert.deepEqual(result.details, { mode: "notify", sent: true });
		assert.deepEqual(bridge.messages, [{ chatId: config.chatId, text: "Done" }]);
	});

	it("ask sends a question and resolves via text handler", async () => {
		const { controller, bridge } = await enabledController();
		const resultPromise = controller.executeTool({ mode: "ask", questions: [question()] });
		await flushAsync();

		assert.equal(bridge.questions.length, 1);
		assert.equal(bridge.questions[0]?.question.question, "What should Pi do next?");

		await bridge.handlers.onText?.({ chatId: config.chatId, userId: config.userId, text: "  Use option C  ", isPrivate: true });
		const result = await resultPromise;

		assert.deepEqual(result.details, {
			mode: "ask",
			answers: [{ id: "decision", value: "Use option C", label: "Use option C", wasCustom: true }],
		});
		assert.match(result.content[0]?.text ?? "", /decision: user wrote: Use option C/);
	});

	it("callback answer resolves ask and acknowledges callback", async () => {
		const { controller, bridge } = await enabledController();
		const resultPromise = controller.executeTool({ mode: "ask", questions: [question()] });
		await flushAsync();
		const active = bridge.questions[0];
		assert.ok(active);

		await bridge.handlers.onCallback?.({
			callbackQueryId: "cb-1",
			chatId: config.chatId,
			userId: config.userId,
			data: buildCallbackData(active.nonce, 1),
		});
		const result = await resultPromise;

		assert.deepEqual(result.details, {
			mode: "ask",
			answers: [{ id: "decision", value: "wait", label: "Wait", wasCustom: false }],
		});
		assert.deepEqual(bridge.callbacks, [{ callbackQueryId: "cb-1", text: "Answer received" }]);
	});

	it("ignores unrelated Telegram text and callback", async () => {
		const { controller, bridge } = await enabledController();
		const resultPromise = controller.executeTool({ mode: "ask", questions: [question()] });
		await flushAsync();
		const active = bridge.questions[0];
		assert.ok(active);

		await bridge.handlers.onText?.({ chatId: 999, userId: config.userId, text: "wrong chat", isPrivate: true });
		await bridge.handlers.onText?.({ chatId: config.chatId, userId: 999, text: "wrong user", isPrivate: true });
		await bridge.handlers.onCallback?.({
			callbackQueryId: "cb-unlinked",
			chatId: 999,
			userId: config.userId,
			data: buildCallbackData(active.nonce, 0),
		});
		assert.equal(bridge.callbacks.length, 0);

		await bridge.handlers.onCallback?.({
			callbackQueryId: "cb-real",
			chatId: config.chatId,
			userId: config.userId,
			data: buildCallbackData(active.nonce, 0),
		});
		assert.deepEqual((await resultPromise).details, {
			mode: "ask",
			answers: [{ id: "decision", value: "ship", label: "Ship it", wasCustom: false }],
		});
	});

	it("linked Telegram text with no pending question sends no-pending message", async () => {
		const { bridge } = await enabledController();

		await bridge.handlers.onText?.({ chatId: config.chatId, userId: config.userId, text: "hello", isPrivate: true });

		assert.deepEqual(bridge.messages, [
			{
				chatId: config.chatId,
				text: "No AFK question is pending right now. Use Pi locally, or wait for the agent to ask something.",
			},
		]);
	});

	it("disable cancels pending ask", async () => {
		const { controller, bridge, lock } = await enabledController();
		const resultPromise = controller.executeTool({ mode: "ask", questions: [question()] });
		await flushAsync();

		await controller.disable("AFK disabled");
		const result = await resultPromise;

		assert.deepEqual(result.details, { mode: "cancelled", reason: "AFK disabled" });
		assert.deepEqual(bridge.messages, [{ chatId: config.chatId, text: "AFK question cancelled: AFK disabled" }]);
		assert.equal(bridge.stopped, true);
		assert.equal(lock.released, true);
	});

	it("toggleAfk sets status and notifications for enable and disable", async () => {
		const home = await tempHome();
		await writeConfig(config, home);
		const controller = new AfkController({
			home,
			createBridge: (_token, handlers) => new FakeBridge(handlers),
			createLock: () => new FakeLock({ ok: true }),
		});
		const { ctx, notifications, statuses } = fakeCommandCtx();

		await toggleAfk(controller, ctx);
		await toggleAfk(controller, ctx);

		assert.deepEqual(statuses, [
			{ key: "afk", text: "AFK: on" },
			{ key: "afk", text: undefined },
		]);
		assert.deepEqual(notifications, [
			{ message: "AFK mode on", type: "info" },
			{ message: "AFK mode off", type: "info" },
		]);
	});
});

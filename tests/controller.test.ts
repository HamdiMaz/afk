import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ActiveTelegramQuestion } from "../extensions/ask-queue.ts";
import { AfkController, shutdownAfk, toggleAfk } from "../extensions/controller.ts";
import { readConfig, writeConfig } from "../extensions/config.ts";
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

const fakeCommandCtx = (inputResult: string | undefined = undefined) => {
	const notifications: Array<{ message: string; type?: "info" | "warning" | "error" }> = [];
	const statuses: Array<{ key: string; text: string | undefined }> = [];
	return {
		notifications,
		statuses,
		ctx: {
			hasUI: true,
			ui: {
				async input() {
					return inputResult;
				},
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

const waitFor = async (condition: () => boolean, timeoutMs = 100): Promise<void> => {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
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

	it("enable releases lock and stops bridge when bridge start throws", async () => {
		const home = await tempHome();
		await writeConfig(config, home);
		let lock: FakeLock | undefined;
		let bridge: ThrowingStartBridge | undefined;
		class ThrowingStartBridge extends FakeBridge {
			override start(): void {
				this.started = true;
				throw new Error("start failed");
			}
		}
		const controller = new AfkController({
			home,
			createBridge: (_token, handlers) => (bridge = new ThrowingStartBridge(handlers)),
			createLock: () => (lock = new FakeLock({ ok: true })),
		});

		await assert.rejects(() => controller.enable(), /start failed/);

		assert.equal(controller.isAfkEnabled, false);
		assert.equal(bridge?.stopped, true);
		assert.equal(lock?.released, true);
	});

	it("enable releases lock and stops bridge when bridge start rejects", async () => {
		const home = await tempHome();
		await writeConfig(config, home);
		let lock: FakeLock | undefined;
		let bridge: RejectingStartBridge | undefined;
		class RejectingStartBridge extends FakeBridge {
			override start(): void {
				this.started = true;
				return Promise.reject(new Error("start rejected")) as unknown as void;
			}
		}
		const controller = new AfkController({
			home,
			createBridge: (_token, handlers) => (bridge = new RejectingStartBridge(handlers)),
			createLock: () => (lock = new FakeLock({ ok: true })),
		});

		await assert.rejects(() => controller.enable(), /start rejected/);

		assert.equal(controller.isAfkEnabled, false);
		assert.equal(bridge?.stopped, true);
		assert.equal(lock?.released, true);
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

	it("executeTool returns cancelled details when ask signal aborts", async () => {
		const { controller, bridge } = await enabledController();
		const abortController = new AbortController();
		const resultPromise = controller.executeTool({ mode: "ask", questions: [question()] }, abortController.signal);
		await flushAsync();

		abortController.abort("agent cancelled");
		const result = await resultPromise;

		assert.deepEqual(result.details, { mode: "cancelled", reason: "agent cancelled" });
		assert.deepEqual(bridge.messages, [{ chatId: config.chatId, text: "AFK question cancelled: agent cancelled" }]);
	});

	it("enabled bridge polling error disables AFK and releases lock", async () => {
		const { controller, bridge, lock } = await enabledController();

		bridge.handlers.onPollingError?.(new Error("poll failed"));
		await waitFor(() => lock.released);

		assert.equal(controller.isAfkEnabled, false);
		assert.equal(bridge.stopped, true);
		assert.equal(lock.released, true);
	});

	it("shutdownAfk clears status and disables/releases AFK", async () => {
		const { controller, bridge, lock } = await enabledController();
		const { ctx, statuses } = fakeCommandCtx();

		await shutdownAfk(controller, ctx, "test shutdown");

		assert.equal(controller.isAfkEnabled, false);
		assert.equal(bridge.stopped, true);
		assert.equal(lock.released, true);
		assert.deepEqual(statuses, [{ key: "afk", text: undefined }]);
	});

	it("runSettings cancelled token prompt returns without starting bridge and notifies cancellation", async () => {
		let created = false;
		const { ctx, notifications } = fakeCommandCtx(undefined);
		const controller = new AfkController({
			home: await tempHome(),
			createBridge: (_token, handlers) => {
				created = true;
				return new FakeBridge(handlers);
			},
		});

		await controller.runSettings(ctx);

		assert.equal(created, false);
		assert.deepEqual(notifications, [{ message: "AFK settings cancelled.", type: "warning" }]);
	});

	it("runSettings successful link writes config and stops bridge", async () => {
		const home = await tempHome();
		let bridge: FakeBridge | undefined;
		const { ctx, notifications } = fakeCommandCtx("999:token");
		const controller = new AfkController({
			home,
			settingsLinkTimeoutMs: 100,
			settingsPollIntervalMs: 1,
			createBridge: (_token, handlers) => (bridge = new FakeBridge(handlers)),
		});

		const settingsPromise = controller.runSettings(ctx);
		await waitFor(() => notifications.some(({ message }) => message.includes("Send this one-time code")));
		const code = notifications.find(({ message }) => message.includes("Send this one-time code"))?.message.match(/AFK-\d{6}/)?.[0];
		assert.ok(code);
		await bridge?.handlers.onText?.({ chatId: 123, userId: 456, text: code, isPrivate: true });
		await settingsPromise;

		assert.deepEqual(await readConfig(home), { botToken: "999:token", botUsername: "fake_bot", chatId: 123, userId: 456 });
		assert.equal(bridge?.stopped, true);
		assert.deepEqual(notifications.at(-1), { message: "AFK Telegram settings saved.", type: "info" });
	});

	it("runSettings wrong or no code times out and stops bridge with warning", async () => {
		let bridge: FakeBridge | undefined;
		const { ctx, notifications } = fakeCommandCtx("999:token");
		const controller = new AfkController({
			home: await tempHome(),
			settingsLinkTimeoutMs: 5,
			settingsPollIntervalMs: 1,
			createBridge: (_token, handlers) => (bridge = new FakeBridge(handlers)),
		});

		await controller.runSettings(ctx);

		assert.equal(bridge?.stopped, true);
		assert.deepEqual(notifications.at(-1), { message: "AFK Telegram link timed out.", type: "warning" });
	});

	it("runSettings polling error stops bridge and notifies warning", async () => {
		let bridge: FakeBridge | undefined;
		const { ctx, notifications } = fakeCommandCtx("999:token");
		const controller = new AfkController({
			home: await tempHome(),
			settingsLinkTimeoutMs: 100,
			settingsPollIntervalMs: 1,
			createBridge: (_token, handlers) => (bridge = new FakeBridge(handlers)),
		});

		const settingsPromise = controller.runSettings(ctx);
		await waitFor(() => notifications.some(({ message }) => message.includes("Send this one-time code")));
		bridge?.handlers.onPollingError?.(new Error("poll failed"));
		await settingsPromise;

		assert.equal(bridge?.stopped, true);
		assert.deepEqual(notifications.at(-1), { message: "AFK Telegram polling failed during settings link.", type: "warning" });
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

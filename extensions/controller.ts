import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AfkAskCancelledError, AskQueue, type ActiveTelegramQuestion, type AskQueueTransport } from "./ask-queue.ts";
import { getAfkHome, readConfig, writeConfig } from "./config.ts";
import { AfkLock } from "./lock.ts";
import { parseCallbackData } from "./telegram-format.ts";
import { TelegramBridge, type TelegramBridgeHandlers, type TelegramBridgePort } from "./telegram.ts";
import type {
	AfkAnswer,
	AfkConfig,
	AfkToolDetails,
	AfkToolParams,
	LinkedTelegramCallback,
	LinkedTelegramMessage,
} from "./types.ts";

export interface AfkLockPort {
	acquire(): Promise<{ ok: true } | { ok: false; reason: string }>;
	release(): Promise<void>;
}

export interface AfkControllerOptions {
	home?: string;
	settingsLinkTimeoutMs?: number;
	settingsPollIntervalMs?: number;
	createBridge?: (token: string, handlers: TelegramBridgeHandlers) => TelegramBridgePort;
	createLock?: (token: string, home: string) => AfkLockPort;
}

export type EnableResult = { ok: true } | { ok: false; reason: string };

export interface AfkToolResponse {
	content: Array<{ type: "text"; text: string }>;
	details: AfkToolDetails;
}

const NO_CONFIG_REASON = "Telegram is not configured. Run /afk-settings first.";
const DISABLED_REASON = "AFK mode is off";
const NO_PENDING_MESSAGE = "No AFK question is pending right now. Use Pi locally, or wait for the agent to ask something.";
const DEFAULT_SETTINGS_LINK_TIMEOUT_MS = 120_000;
const DEFAULT_SETTINGS_POLL_INTERVAL_MS = 250;

export class AfkController implements AskQueueTransport {
	private readonly home: string;
	private readonly createBridge: (token: string, handlers: TelegramBridgeHandlers) => TelegramBridgePort;
	private readonly createLock: (token: string, home: string) => AfkLockPort;
	private readonly settingsLinkTimeoutMs: number;
	private readonly settingsPollIntervalMs: number;
	private config: AfkConfig | undefined;
	private bridge: TelegramBridgePort | undefined;
	private lock: AfkLockPort | undefined;
	private askQueue: AskQueue;
	private afkEnabled = false;

	constructor(options: AfkControllerOptions = {}) {
		this.home = options.home ?? getAfkHome();
		this.settingsLinkTimeoutMs = options.settingsLinkTimeoutMs ?? DEFAULT_SETTINGS_LINK_TIMEOUT_MS;
		this.settingsPollIntervalMs = options.settingsPollIntervalMs ?? DEFAULT_SETTINGS_POLL_INTERVAL_MS;
		this.createBridge = options.createBridge ?? ((token, handlers) => new TelegramBridge(token, handlers));
		this.createLock = options.createLock ?? ((token, home) => new AfkLock(token, home));
		this.askQueue = new AskQueue(this);
	}

	get isAfkEnabled(): boolean {
		return this.afkEnabled;
	}

	async enable(): Promise<EnableResult> {
		if (this.afkEnabled) return { ok: true };

		const config = await readConfig(this.home);
		if (!config) return { ok: false, reason: NO_CONFIG_REASON };

		const lock = this.createLock(config.botToken, this.home);
		const acquired = await lock.acquire();
		if (!acquired.ok) return { ok: false, reason: acquired.reason };

		let bridge: TelegramBridgePort | undefined;
		try {
			bridge = this.createBridge(config.botToken, this.handlers());
			this.config = config;
			this.lock = lock;
			this.bridge = bridge;
			await Promise.resolve((bridge.start as () => void | Promise<void>)());
			this.afkEnabled = true;
			return { ok: true };
		} catch (error) {
			try {
				bridge?.stop();
			} finally {
				await lock.release();
				this.config = undefined;
				this.lock = undefined;
				this.bridge = undefined;
				this.afkEnabled = false;
			}
			throw error;
		}
	}

	async disable(reason: string): Promise<void> {
		this.afkEnabled = false;
		this.askQueue.cancelAll(reason);

		try {
			this.bridge?.stop();
		} finally {
			await this.lock?.release();
			this.bridge = undefined;
			this.lock = undefined;
			this.config = undefined;
			this.askQueue = new AskQueue(this);
		}
	}

	promptGuidance(): string | undefined {
		if (!this.afkEnabled) return undefined;
		return "The user is AFK. For questions, clarification, progress updates, or decisions, use the afk tool. Do not use local-only user prompt tools.";
	}

	async executeTool(params: AfkToolParams, signal?: AbortSignal): Promise<AfkToolResponse> {
		if (!this.afkEnabled || !this.config || !this.bridge) {
			return {
				content: [{ type: "text", text: "AFK mode is off. Continue normally and ask the user locally if needed." }],
				details: { mode: "disabled", reason: DISABLED_REASON },
			};
		}

		if (params.mode === "notify") {
			const message = params.message?.trim();
			if (!message) {
				return {
					content: [{ type: "text", text: "AFK notify requires a nonblank message." }],
					details: { mode: "error", reason: "AFK notify requires a nonblank message" },
				};
			}

			await this.bridge.sendMessage(this.config.chatId, message);
			return { content: [{ type: "text", text: "AFK notification sent." }], details: { mode: "notify", sent: true } };
		}

		if (!params.questions?.length) {
			return {
				content: [{ type: "text", text: "AFK ask requires at least one question." }],
				details: { mode: "error", reason: "AFK ask requires at least one question" },
			};
		}

		try {
			const answers = await this.askQueue.enqueue(params.questions, signal);
			return { content: [{ type: "text", text: this.formatAnswers(answers) }], details: { mode: "ask", answers } };
		} catch (error) {
			if (error instanceof AfkAskCancelledError) {
				return { content: [{ type: "text", text: error.message }], details: { mode: "cancelled", reason: error.message } };
			}
			throw error;
		}
	}

	async sendQuestion(active: ActiveTelegramQuestion): Promise<void> {
		if (!this.config || !this.bridge) return;
		await this.bridge.sendQuestion(this.config, active);
	}

	async sendCancellation(reason: string): Promise<void> {
		if (!this.config || !this.bridge) return;
		await this.bridge.sendMessage(this.config.chatId, `AFK question cancelled: ${reason}`);
	}

	async runSettings(ctx: ExtensionCommandContext): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify("AFK settings require interactive UI.", "warning");
			return;
		}

		const token = (await ctx.ui.input("Telegram bot token", "123456:ABCDEF"))?.trim();
		if (!token) {
			ctx.ui.notify("AFK settings cancelled.", "warning");
			return;
		}

		const code = `AFK-${Math.floor(100_000 + Math.random() * 900_000)}`;
		let linked = false;
		let pollingError: unknown;
		let bridge: TelegramBridgePort | undefined;

		try {
			bridge = this.createBridge(token, {
				onText: async (message) => {
					if (!message.isPrivate || message.text.trim() !== code || !bridge) return;
					const me = await bridge.getMe();
					await writeConfig(
						{ botToken: token, botUsername: me.username, chatId: message.chatId, userId: message.userId },
						this.home,
					);
					await bridge.sendMessage(message.chatId, "AFK linked successfully ✅");
					linked = true;
				},
				onPollingError: (error) => {
					pollingError = error;
				},
			});

			const me = await bridge.getMe();
			await Promise.resolve((bridge.start as () => void | Promise<void>)());
			ctx.ui.notify(`Send this one-time code to @${me.username}: ${code}`, "info");

			const deadline = Date.now() + this.settingsLinkTimeoutMs;
			while (!linked) {
				if (pollingError) {
					ctx.ui.notify("AFK Telegram polling failed during settings link.", "warning");
					return;
				}
				if (Date.now() >= deadline) {
					ctx.ui.notify("AFK Telegram link timed out.", "warning");
					return;
				}
				await new Promise((resolve) =>
					setTimeout(resolve, Math.max(1, Math.min(this.settingsPollIntervalMs, deadline - Date.now()))),
				);
			}
			ctx.ui.notify("AFK Telegram settings saved.", "info");
		} catch {
			ctx.ui.notify("AFK Telegram settings failed.", "error");
		} finally {
			bridge?.stop();
		}
	}

	private handlers(): TelegramBridgeHandlers {
		return {
			onText: (message) => this.handleText(message),
			onCallback: (callback) => this.handleCallback(callback),
			onPollingError: () => {
				void this.disable("AFK Telegram polling failed").catch(() => {});
			},
		};
	}

	private async handleText(message: LinkedTelegramMessage): Promise<void> {
		if (!this.config || !this.bridge) return;
		if (!this.isLinkedMessage(message)) return;

		const answered = await this.askQueue.answerWithText(message.text);
		if (!answered) await this.bridge.sendMessage(this.config.chatId, NO_PENDING_MESSAGE);
	}

	private async handleCallback(callback: LinkedTelegramCallback): Promise<void> {
		if (!this.config || !this.bridge) return;
		if (callback.chatId !== this.config.chatId || callback.userId !== this.config.userId) return;

		const parsed = parseCallbackData(callback.data);
		if (!parsed) {
			await this.bridge.answerCallback(callback.callbackQueryId, "Invalid AFK answer");
			return;
		}

		const answered = await this.askQueue.answerWithOption(parsed.nonce, parsed.optionIndex);
		await this.bridge.answerCallback(callback.callbackQueryId, answered ? "Answer received" : "This question is no longer active");
	}

	private isLinkedMessage(message: LinkedTelegramMessage): boolean {
		return Boolean(
			this.config && message.isPrivate && message.chatId === this.config.chatId && message.userId === this.config.userId,
		);
	}

	private formatAnswers(answers: AfkAnswer[]): string {
		if (answers.length === 0) return "No AFK answers received.";
		return answers
			.map((answer) => `${answer.id}: ${answer.wasCustom ? "user wrote" : "user selected"}: ${answer.label}`)
			.join("\n");
	}
}

export async function toggleAfk(controller: AfkController, ctx: ExtensionCommandContext): Promise<void> {
	if (controller.isAfkEnabled) {
		await controller.disable("AFK disabled");
		ctx.ui.setStatus("afk", undefined);
		ctx.ui.notify("AFK mode off", "info");
		return;
	}

	const result = await controller.enable();
	if (!result.ok) {
		ctx.ui.notify(result.reason, "warning");
		return;
	}

	ctx.ui.setStatus("afk", "AFK: on");
	ctx.ui.notify("AFK mode on", "info");
}

export async function shutdownAfk(controller: AfkController, ctx: ExtensionContext, reason: string): Promise<void> {
	await controller.disable(reason);
	ctx.ui.setStatus("afk", undefined);
}

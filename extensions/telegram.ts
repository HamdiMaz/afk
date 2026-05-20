import { Bot, InlineKeyboard } from "grammy";
import type { ActiveTelegramQuestion } from "./ask-queue.ts";
import type { AfkConfig, LinkedTelegramCallback, LinkedTelegramMessage } from "./types.ts";
import { buildQuestionPayload } from "./telegram-format.ts";

export interface TelegramBridgeHandlers {
	onText?: (message: LinkedTelegramMessage) => void | Promise<void>;
	onMessage?: (message: LinkedTelegramMessage) => void | Promise<void>;
	onCallback?: (callback: LinkedTelegramCallback) => void | Promise<void>;
	onPollingError?: (error: unknown) => void;
}

interface TelegramBotLike {
	on(event: "message:text" | "callback_query:data", handler: (ctx: TelegramContextLike) => void | Promise<void>): void;
	catch?(handler: (error: unknown) => void): void;
	init(): Promise<void>;
	start(): void | Promise<void>;
	stop(): void;
	api: {
		getMe(): Promise<{ username?: string; first_name: string }>;
		sendMessage(chatId: number, text: string, options?: unknown): Promise<void>;
		answerCallbackQuery(callbackQueryId: string, options?: { text: string }): Promise<void>;
	};
}

interface TelegramContextLike {
	chat: { id: number; type?: string };
	from: { id: number };
	message: { text: string };
	callbackQuery: { id: string; data: string; message?: { chat: { id: number } } };
}

export interface TelegramBridgePort {
	getMe(): Promise<{ username: string }>;
	start(): Promise<void>;
	stop(): void;
	sendMessage(chatId: number, text: string): Promise<void>;
	sendQuestion(config: Pick<AfkConfig, "chatId">, active: ActiveTelegramQuestion): Promise<void>;
	answerCallback(callbackQueryId: string, text?: string): Promise<void>;
}

export class TelegramBridge implements TelegramBridgePort {
	private readonly bot: TelegramBotLike;
	private pollingPromise: Promise<void> | undefined;

	constructor(token: string, private readonly handlers: TelegramBridgeHandlers, bot?: TelegramBotLike) {
		this.bot = bot ?? (new Bot(token) as unknown as TelegramBotLike);
		this.bot.on("message:text", (ctx) =>
			this.isolateHandlerError(async () => {
				const handler = this.handlers.onText ?? this.handlers.onMessage;
				await handler?.({
					chatId: ctx.chat.id,
					userId: ctx.from.id,
					text: ctx.message.text,
					isPrivate: ctx.chat.type === "private",
				});
			}),
		);
		this.bot.on("callback_query:data", (ctx) => this.handleCallbackQuery(ctx));
		this.bot.catch?.((error) => this.reportPollingError(error));
	}

	async getMe(): Promise<{ username: string }> {
		const me = await this.bot.api.getMe();
		return { username: me.username ?? me.first_name };
	}

	async start(): Promise<void> {
		if (this.pollingPromise) return;

		await this.bot.init();
		if (this.pollingPromise) return;

		this.pollingPromise = Promise.resolve()
			.then(() => this.bot.start())
			.catch((error: unknown) => {
				this.pollingPromise = undefined;
				this.reportPollingError(error);
			});
	}

	stop(): void {
		if (!this.pollingPromise) return;
		try {
			this.bot.stop();
		} catch (error) {
			this.reportPollingError(error);
		} finally {
			this.pollingPromise = undefined;
		}
	}

	async sendMessage(chatId: number, text: string): Promise<void> {
		await this.bot.api.sendMessage(chatId, text);
	}

	async sendQuestion(config: Pick<AfkConfig, "chatId">, active: ActiveTelegramQuestion): Promise<void> {
		const payload = buildQuestionPayload(active);
		const keyboard = new InlineKeyboard();
		payload.buttons.forEach((row, rowIndex) => {
			if (rowIndex > 0) keyboard.row();
			for (const button of row) {
				keyboard.text(button.text, button.callbackData);
			}
		});

		await this.bot.api.sendMessage(config.chatId, payload.text, { reply_markup: keyboard });
	}

	async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
		if (text) {
			await this.bot.api.answerCallbackQuery(callbackQueryId, { text });
			return;
		}
		await this.bot.api.answerCallbackQuery(callbackQueryId);
	}

	private async handleCallbackQuery(ctx: TelegramContextLike): Promise<void> {
		const { callbackQuery } = ctx;
		const message = callbackQuery.message;
		if (!message) {
			await this.isolateHandlerError(() => this.answerCallback(callbackQuery.id));
			return;
		}

		try {
			await this.handlers.onCallback?.({
				callbackQueryId: callbackQuery.id,
				chatId: message.chat.id,
				userId: ctx.from.id,
				data: callbackQuery.data,
			});
		} catch (error) {
			try {
				await this.answerCallback(callbackQuery.id);
			} catch (answerError) {
				this.reportPollingError(answerError);
			}
			this.reportPollingError(error);
		}
	}

	private async isolateHandlerError(handler: () => void | Promise<void>): Promise<void> {
		try {
			await handler();
		} catch (error) {
			this.reportPollingError(error);
		}
	}

	private reportPollingError(error: unknown): void {
		try {
			this.handlers.onPollingError?.(error);
		} catch {
			// Keep polling alive even if the error reporter fails.
		}
	}
}

import { Bot, InlineKeyboard } from "grammy";
import type { ActiveTelegramQuestion } from "./ask-queue.ts";
import type { AfkConfig, LinkedTelegramCallback, LinkedTelegramMessage } from "./types.ts";
import { buildQuestionPayload } from "./telegram-format.ts";

export interface TelegramBridgeHandlers {
	onMessage(message: LinkedTelegramMessage): void | Promise<void>;
	onCallback(callback: LinkedTelegramCallback): void | Promise<void>;
	onPollingError?: (error: unknown) => void;
}

export interface TelegramBridgePort {
	getMe(): Promise<{ username: string }>;
	start(): void;
	stop(): void;
	sendMessage(chatId: number, text: string): Promise<void>;
	sendQuestion(config: Pick<AfkConfig, "chatId">, active: ActiveTelegramQuestion): Promise<void>;
	answerCallback(callbackQueryId: string, text?: string): Promise<void>;
}

export class TelegramBridge implements TelegramBridgePort {
	private readonly bot: Bot;
	private pollingPromise: Promise<void> | undefined;

	constructor(token: string, private readonly handlers: TelegramBridgeHandlers) {
		this.bot = new Bot(token);
		this.bot.on("message:text", async (ctx) => {
			await this.handlers.onMessage({
				chatId: ctx.chat.id,
				userId: ctx.from.id,
				text: ctx.message.text,
				isPrivate: ctx.chat.type === "private",
			});
		});
		this.bot.on("callback_query:data", async (ctx) => {
			const message = ctx.callbackQuery.message;
			await this.handlers.onCallback({
				callbackQueryId: ctx.callbackQuery.id,
				chatId: message?.chat.id ?? 0,
				userId: ctx.from.id,
				data: ctx.callbackQuery.data,
			});
		});
	}

	async getMe(): Promise<{ username: string }> {
		const me = await this.bot.api.getMe();
		return { username: me.username ?? me.first_name };
	}

	start(): void {
		if (this.pollingPromise) return;

		this.pollingPromise = this.bot.start().catch((error: unknown) => {
			this.pollingPromise = undefined;
			this.handlers.onPollingError?.(error);
		});
	}

	stop(): void {
		if (!this.pollingPromise) return;
		try {
			this.bot.stop();
		} catch (error) {
			this.handlers.onPollingError?.(error);
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
}

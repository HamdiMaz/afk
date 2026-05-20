import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

export interface AfkConfig {
	botToken: string;
	botUsername: string;
	chatId: number;
	userId: number;
}

export interface LinkedTelegramMessage {
	chatId: number;
	userId: number;
	text: string;
	isPrivate: boolean;
}

export interface LinkedTelegramCallback {
	callbackQueryId: string;
	chatId: number;
	userId: number;
	data: string;
}

export const AfkOptionSchema = Type.Object({
	label: Type.String({ minLength: 1, description: "Button label shown in Telegram" }),
	value: Type.String({ minLength: 1, description: "Value returned to the agent if selected" }),
	description: Type.Optional(Type.String({ description: "Optional context shown in the Telegram message body" })),
	recommended: Type.Optional(Type.Boolean({ description: "Marks this option as recommended in Telegram" })),
});

export const AfkQuestionSchema = Type.Object({
	id: Type.String({ minLength: 1, description: "Stable identifier used in the returned answer" }),
	question: Type.String({ minLength: 1, description: "Question text sent to Telegram" }),
	options: Type.Array(AfkOptionSchema, { minItems: 1, description: "Single-select answer options" }),
});

export const AfkToolParamsSchema = Type.Object({
	mode: StringEnum(["notify", "ask"] as const, { description: "Send a notification or ask blocking questions" }),
	message: Type.Optional(Type.String({ description: "Notification text for mode=notify" })),
	questions: Type.Optional(Type.Array(AfkQuestionSchema, { description: "Questions for mode=ask" })),
});

export type AfkOption = Static<typeof AfkOptionSchema>;
export type AfkQuestion = Static<typeof AfkQuestionSchema>;
export type AfkToolParams = Static<typeof AfkToolParamsSchema>;

export interface AfkAnswer {
	id: string;
	value: string;
	label: string;
	wasCustom: boolean;
}

export interface AfkAskResult {
	mode: "ask";
	answers: AfkAnswer[];
}

export interface AfkNotifyResult {
	mode: "notify";
	sent: boolean;
}

export type AfkToolDetails = AfkAskResult | AfkNotifyResult | { mode: "disabled" | "cancelled" | "error"; reason: string };

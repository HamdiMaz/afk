import type { ActiveTelegramQuestion } from "./ask-queue.ts";

export interface TelegramQuestionButton {
	text: string;
	callbackData: string;
}

export interface TelegramQuestionPayload {
	text: string;
	buttons: TelegramQuestionButton[][];
}

export interface ParsedCallbackData {
	nonce: string;
	optionIndex: number;
}

export function buildCallbackData(nonce: string, optionIndex: number): string {
	return `afk:${nonce}:${optionIndex}`;
}

export function parseCallbackData(data: string): ParsedCallbackData | undefined {
	const parts = data.split(":");
	if (parts.length !== 3) return undefined;

	const [prefix, nonce, rawOptionIndex] = parts;
	if (prefix !== "afk" || !nonce || !rawOptionIndex) return undefined;

	const optionIndex = Number(rawOptionIndex);
	if (!Number.isSafeInteger(optionIndex)) return undefined;

	return { nonce, optionIndex };
}

export function buildQuestionPayload(active: ActiveTelegramQuestion): TelegramQuestionPayload {
	const lines = [
		`Question ${active.questionIndex + 1}/${active.totalQuestions}`,
		"",
		active.question.question,
		"",
		...active.question.options.map((option, index) => {
			const description = option.description ? ` — ${option.description}` : "";
			return `${index + 1}. ${option.label}${description}`;
		}),
		"",
		"Choose an option below, or reply with custom text.",
	];

	return {
		text: lines.join("\n"),
		buttons: active.question.options.map((option, index) => [
			{
				text: `${option.recommended ? "⭐ " : ""}${option.label}`,
				callbackData: buildCallbackData(active.nonce, index),
			},
		]),
	};
}

import { randomUUID } from "node:crypto";
import type { AfkAnswer, AfkQuestion } from "./types.ts";

export interface ActiveTelegramQuestion {
	requestId: string;
	nonce: string;
	questionIndex: number;
	totalQuestions: number;
	question: AfkQuestion;
}

export interface AskQueueTransport {
	sendQuestion(active: ActiveTelegramQuestion): Promise<void>;
	sendCancellation(reason: string): Promise<void>;
}

export interface AskQueueOptions {
	makeNonce?: () => string;
}

interface QueuedAsk {
	requestId: string;
	questions: AfkQuestion[];
	answers: AfkAnswer[];
	resolve: (answers: AfkAnswer[]) => void;
	reject: (error: Error) => void;
	removeAbortListener: () => void;
}

interface ActiveAsk extends QueuedAsk {
	questionIndex: number;
	nonce: string;
}

export class AfkAskCancelledError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AfkAskCancelledError";
	}
}

const abortReason = (signal: AbortSignal): string => {
	const { reason } = signal;
	if (typeof reason === "string" && reason.trim()) return reason;
	return "AFK ask was aborted";
};

export class AskQueue {
	private readonly queue: QueuedAsk[] = [];
	private active: ActiveAsk | undefined;
	private readonly makeNonce: () => string;

	constructor(
		private readonly transport: AskQueueTransport,
		options: AskQueueOptions = {},
	) {
		this.makeNonce = options.makeNonce ?? (() => randomUUID().slice(0, 8));
	}

	enqueue(questions: AfkQuestion[], signal?: AbortSignal): Promise<AfkAnswer[]> {
		if (questions.length === 0) {
			return Promise.reject(new Error("AFK ask requires at least one question"));
		}

		return new Promise<AfkAnswer[]>((resolve, reject) => {
			const request: QueuedAsk = {
				requestId: randomUUID(),
				questions: questions.map((item) => ({
					...item,
					options: item.options.map((option) => ({ ...option })),
				})),
				answers: [],
				resolve,
				reject,
				removeAbortListener: () => {},
			};
			const abort = () => {
				const reason = signal ? abortReason(signal) : "AFK ask was aborted";
				if (this.active?.requestId === request.requestId) {
					this.cancelActive(reason);
					return;
				}

				if (this.removeQueued(request.requestId)) {
					request.removeAbortListener();
					reject(new AfkAskCancelledError(reason));
				}
			};

			if (signal?.aborted) {
				reject(new AfkAskCancelledError(abortReason(signal)));
				return;
			}

			if (signal) {
				signal.addEventListener("abort", abort, { once: true });
				request.removeAbortListener = () => signal.removeEventListener("abort", abort);
			}

			this.queue.push(request);
			void this.pump();
		});
	}

	async answerWithOption(nonce: string, optionIndex: number): Promise<boolean> {
		const active = this.active;
		if (!active || active.nonce !== nonce) return false;

		const question = active.questions[active.questionIndex];
		const option = question?.options[optionIndex];
		if (!question || !option) return false;

		active.answers.push({ id: question.id, value: option.value, label: option.label, wasCustom: false });
		await this.advance();
		return true;
	}

	async answerWithText(text: string): Promise<boolean> {
		const active = this.active;
		if (!active) return false;

		const trimmed = text.trim();
		if (!trimmed) return false;

		const question = active.questions[active.questionIndex];
		if (!question) return false;

		active.answers.push({ id: question.id, value: trimmed, label: trimmed, wasCustom: true });
		await this.advance();
		return true;
	}

	cancelAll(reason: string): void {
		const error = new AfkAskCancelledError(reason);
		const hadActive = Boolean(this.active);

		if (this.active) {
			this.active.removeAbortListener();
			this.active.reject(error);
			this.active = undefined;
		}

		for (const item of this.queue.splice(0)) {
			item.removeAbortListener();
			item.reject(error);
		}

		if (hadActive) void this.transport.sendCancellation(reason).catch(() => {});
	}

	get hasPendingQuestion(): boolean {
		return Boolean(this.active);
	}

	private async pump(): Promise<void> {
		if (this.active || this.queue.length === 0) return;

		const next = this.queue.shift();
		if (!next) return;

		const active = { ...next, questionIndex: 0, nonce: this.makeNonce() };
		this.active = active;
		try {
			await this.sendActiveQuestion(active);
		} catch (error) {
			await this.rejectActiveAndPump(error, active);
		}
	}

	private async sendActiveQuestion(active: ActiveAsk): Promise<void> {
		const question = active.questions[active.questionIndex];
		if (!question) return;

		await this.transport.sendQuestion({
			requestId: active.requestId,
			nonce: active.nonce,
			questionIndex: active.questionIndex,
			totalQuestions: active.questions.length,
			question,
		});
	}

	private async advance(): Promise<void> {
		const active = this.active;
		if (!active) return;

		if (active.questionIndex + 1 >= active.questions.length) {
			active.removeAbortListener();
			active.resolve(active.answers);
			this.active = undefined;
			await this.pump();
			return;
		}

		active.questionIndex += 1;
		active.nonce = this.makeNonce();
		try {
			await this.sendActiveQuestion(active);
		} catch (error) {
			await this.rejectActiveAndPump(error, active);
		}
	}

	private removeQueued(requestId: string): boolean {
		const index = this.queue.findIndex((item) => item.requestId === requestId);
		if (index < 0) return false;
		this.queue.splice(index, 1);
		return true;
	}

	private cancelActive(reason: string): void {
		if (!this.active) return;

		const active = this.active;
		active.removeAbortListener();
		active.reject(new AfkAskCancelledError(reason));
		this.active = undefined;
		void this.transport.sendCancellation(reason).catch(() => {});
		void this.pump();
	}

	private async rejectActiveAndPump(error: unknown, failedActive: ActiveAsk): Promise<void> {
		const active = this.active;
		if (!active || active.requestId !== failedActive.requestId) return;

		active.removeAbortListener();
		active.reject(error instanceof Error ? error : new Error(String(error)));
		this.active = undefined;
		await this.pump();
	}
}

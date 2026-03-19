import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export type WorkflowFeedbackScopeKind = "workflow" | "agent" | "step" | "tool";
export type WorkflowFeedbackStatus = "success" | "error";
export type WorkflowFeedbackNoteLevel = "info" | "warning" | "error";

export interface WorkflowFeedbackProgress {
	completed: number;
	total: number;
}

export interface WorkflowFeedbackScope {
	id: string;
	parentId?: string;
	kind: WorkflowFeedbackScopeKind;
	label: string;
}

export interface WorkflowFeedbackStartEvent {
	type: "start";
	scope: WorkflowFeedbackScope;
	timestamp: number;
}

export interface WorkflowFeedbackUpdateEvent {
	type: "update";
	scopeId: string;
	message?: string;
	progress?: WorkflowFeedbackProgress;
	timestamp: number;
}

export interface WorkflowFeedbackFinishEvent {
	type: "finish";
	scopeId: string;
	status: WorkflowFeedbackStatus;
	durationMs: number;
	summary?: string;
	error?: string;
	timestamp: number;
}

export interface WorkflowFeedbackArtifactEvent {
	type: "artifact";
	scopeId?: string;
	label: string;
	value: unknown;
	timestamp: number;
}

export interface WorkflowFeedbackNoteEvent {
	type: "note";
	scopeId?: string;
	level: WorkflowFeedbackNoteLevel;
	message: string;
	timestamp: number;
}

export type WorkflowFeedbackEvent =
	| WorkflowFeedbackStartEvent
	| WorkflowFeedbackUpdateEvent
	| WorkflowFeedbackFinishEvent
	| WorkflowFeedbackArtifactEvent
	| WorkflowFeedbackNoteEvent;

export interface WorkflowFeedbackSink {
	emit(event: WorkflowFeedbackEvent): void;
}

interface WorkflowFeedbackContext {
	sink: WorkflowFeedbackSink;
	scopeStack: string[];
}

const workflowFeedbackStorage = new AsyncLocalStorage<WorkflowFeedbackContext>();

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function getWorkflowFeedbackContext(): WorkflowFeedbackContext | undefined {
	return workflowFeedbackStorage.getStore();
}

export function getCurrentWorkflowFeedbackScopeId(): string | undefined {
	return getWorkflowFeedbackContext()?.scopeStack.at(-1);
}

export function emitWorkflowFeedback(event: WorkflowFeedbackEvent): void {
	getWorkflowFeedbackContext()?.sink.emit(event);
}

export function runWithWorkflowFeedback<TResult>(sink: WorkflowFeedbackSink, run: () => Promise<TResult>): Promise<TResult>;
export function runWithWorkflowFeedback<TResult>(sink: WorkflowFeedbackSink, run: () => TResult): TResult;
export function runWithWorkflowFeedback<TResult>(sink: WorkflowFeedbackSink, run: () => Promise<TResult> | TResult) {
	return workflowFeedbackStorage.run({ sink, scopeStack: [] }, run);
}

export async function withWorkflowFeedbackScope<TResult>(
	kind: WorkflowFeedbackScopeKind,
	label: string,
	run: () => Promise<TResult>,
): Promise<TResult>;
export async function withWorkflowFeedbackScope<TResult>(
	kind: WorkflowFeedbackScopeKind,
	label: string,
	run: () => TResult,
): Promise<TResult>;
export async function withWorkflowFeedbackScope<TResult>(
	kind: WorkflowFeedbackScopeKind,
	label: string,
	run: () => Promise<TResult> | TResult,
): Promise<TResult> {
	const context = getWorkflowFeedbackContext();
	if (!context) {
		return run();
	}

	const scope: WorkflowFeedbackScope = {
		id: randomUUID(),
		parentId: context.scopeStack.at(-1),
		kind,
		label,
	};
	const startedAt = Date.now();
	context.sink.emit({
		type: "start",
		scope,
		timestamp: startedAt,
	});

	return workflowFeedbackStorage.run({ sink: context.sink, scopeStack: [...context.scopeStack, scope.id] }, async () => {
		try {
			const result = await run();
			context.sink.emit({
				type: "finish",
				scopeId: scope.id,
				status: "success",
				durationMs: Date.now() - startedAt,
				timestamp: Date.now(),
			});
			return result;
		} catch (error) {
			context.sink.emit({
				type: "finish",
				scopeId: scope.id,
				status: "error",
				durationMs: Date.now() - startedAt,
				error: describeError(error),
				timestamp: Date.now(),
			});
			throw error;
		}
	});
}

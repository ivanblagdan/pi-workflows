import { AsyncLocalStorage } from "node:async_hooks";
import { WorkflowAbortError } from "./errors.js";

export interface WorkflowExecutionContext {
	signal?: AbortSignal;
}

const workflowExecutionStorage = new AsyncLocalStorage<WorkflowExecutionContext>();

function createWorkflowAbortError(reason: unknown): WorkflowAbortError {
	if (reason instanceof WorkflowAbortError) {
		return reason;
	}
	if (reason instanceof Error) {
		return new WorkflowAbortError(reason.message, { cause: reason });
	}
	if (typeof reason === "string" && reason.trim().length > 0) {
		return new WorkflowAbortError(reason);
	}
	return new WorkflowAbortError("Workflow execution was aborted.");
}

export function isWorkflowAbortError(error: unknown): error is WorkflowAbortError {
	return error instanceof WorkflowAbortError;
}

export function getCurrentWorkflowAbortSignal(): AbortSignal | undefined {
	return workflowExecutionStorage.getStore()?.signal;
}

export function throwIfWorkflowAborted(signal: AbortSignal | undefined = getCurrentWorkflowAbortSignal()): void {
	if (!signal?.aborted) {
		return;
	}
	throw createWorkflowAbortError(signal.reason);
}

export function runWithWorkflowExecution<TResult>(
	context: WorkflowExecutionContext,
	run: () => Promise<TResult>,
): Promise<TResult>;
export function runWithWorkflowExecution<TResult>(context: WorkflowExecutionContext, run: () => TResult): TResult;
export function runWithWorkflowExecution<TResult>(context: WorkflowExecutionContext, run: () => Promise<TResult> | TResult) {
	return workflowExecutionStorage.run(context, run);
}

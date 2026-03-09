import { WorkflowValidationError } from "./errors.js";
import type { WorkflowValidationContext, WorkflowValidator } from "./types.js";

export function createWorkflowValidationContext(
	cwd: string | undefined,
	input: string,
	attempt: number,
	retriesRemaining: number,
): WorkflowValidationContext {
	return {
		cwd: cwd ?? process.cwd(),
		input,
		attempt,
		retriesRemaining,
	};
}

export function normalizeWorkflowValidationError(
	error: unknown,
	attempts: number,
	retries: number,
): WorkflowValidationError {
	if (error instanceof WorkflowValidationError) {
		return error;
	}
	const message = error instanceof Error ? error.message : String(error);
	return new WorkflowValidationError(message, {
		attempts,
		retries,
		cause: error,
	});
}

export abstract class WorkflowBase<TResult> {
	cwd?: string;
	retries = 1;

	private readonly validators: Array<WorkflowValidator<TResult>> = [];

	retry(count: number): this {
		if (!Number.isInteger(count) || count < 0) {
			throw new Error(`Retry count must be a non-negative integer, got: ${count}`);
		}
		this.retries = count;
		return this;
	}

	validate(validator: WorkflowValidator<TResult>): this {
		this.validators.push(validator);
		return this;
	}

	getValidators(): readonly WorkflowValidator<TResult>[] {
		return this.validators;
	}

	protected async validateResult(
		result: TResult,
		input: string,
		attempt: number,
		retriesRemaining: number,
	): Promise<void> {
		const context = createWorkflowValidationContext(this.cwd, input, attempt, retriesRemaining);
		for (const validator of this.validators) {
			await validator(result, context);
		}
	}

	protected normalizeValidationError(error: unknown, attempts: number): WorkflowValidationError {
		return normalizeWorkflowValidationError(error, attempts, this.retries);
	}
}

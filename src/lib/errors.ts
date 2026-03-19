export class WorkflowValidationError extends Error {
	readonly attempts: number;
	readonly retries: number;
	readonly causeError?: Error;

	constructor(message: string, options: { attempts: number; retries: number; cause?: unknown }) {
		super(message);
		this.name = "WorkflowValidationError";
		this.attempts = options.attempts;
		this.retries = options.retries;
		this.causeError = options.cause instanceof Error ? options.cause : undefined;
	}
}

export class WorkflowAbortError extends Error {
	readonly causeError?: Error;

	constructor(message: string = "Workflow execution was aborted.", options?: { cause?: unknown }) {
		super(message);
		this.name = "WorkflowAbortError";
		this.causeError = options?.cause instanceof Error ? options.cause : undefined;
	}
}

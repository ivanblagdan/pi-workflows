import { WorkflowBase } from "./workflow-base.js";

export abstract class Workflow<TResult> extends WorkflowBase<TResult> {
	invoke = ({ name, input }: { name: string; input: string }): string => {
		const parameters = JSON.stringify({ name, input }, null, 2);
		return [
			"Call the workflow tool exactly once with these exact parameters:",
			"",
			"```json",
			parameters,
			"```",
			"",
			"Do not change the parameters.",
			"After the tool returns, use its result in your response.",
		].join("\n");
	};

	protected abstract runWorkflow(input: string): Promise<TResult>;

	async run(input: string): Promise<TResult> {
		let attempt = 1;
		let retriesRemaining = this.retries;

		while (true) {
			try {
				const result = await this.runWorkflow(input);
				await this.validateResult(result, input, attempt, retriesRemaining);
				return result;
			} catch (error) {
				const workflowError = this.normalizeValidationError(error, attempt);
				if (retriesRemaining <= 0) {
					throw workflowError;
				}

				retriesRemaining--;
				attempt++;
			}
		}
	}
}

import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import type { CreateAgentSessionOptions } from "@mariozechner/pi-coding-agent";
import { withWorkflowFeedbackScope } from "./feedback.js";
import type { WorkflowOutput } from "./outputs.js";
import { runWorkflowAgent } from "./runtime.js";
import type { InferWorkflowResult, WorkflowAgentRuntimeConfig, WorkflowEnvironment } from "./types.js";
import { WorkflowBase } from "./workflow-base.js";

export abstract class WorkflowAgent<TOutput extends WorkflowOutput>
	extends WorkflowBase<InferWorkflowResult<TOutput>>
	implements WorkflowAgentRuntimeConfig<TOutput>
{
	abstract instructions: (input: string) => string;
	abstract output: TOutput;

	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
	tools?: CreateAgentSessionOptions["tools"];
	environment: WorkflowEnvironment = {
		settings: { isolated: true },
		contextFiles: { inherit: "project" },
		extensions: { inherit: false },
		skills: { inherit: false },
		promptTemplates: { inherit: false },
		themes: { inherit: false },
	};

	async run(input: string): Promise<InferWorkflowResult<TOutput>> {
		return withWorkflowFeedbackScope("agent", this.getFeedbackLabel(), () => runWorkflowAgent(this, input));
	}
}

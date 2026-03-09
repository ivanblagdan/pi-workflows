import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import type { CreateAgentSessionOptions } from "@mariozechner/pi-coding-agent";
import type { WorkflowContract } from "./contracts.js";
import { runWorkflowAgent } from "./runtime.js";
import type { InferRunResult, WorkflowAgentRuntimeConfig, WorkflowEnvironment } from "./types.js";
import { WorkflowBase } from "./workflow-base.js";

export abstract class WorkflowAgent<TContract extends WorkflowContract>
	extends WorkflowBase<InferRunResult<TContract>>
	implements WorkflowAgentRuntimeConfig<TContract>
{
	abstract instructions: (input: string) => string;
	abstract contract: TContract;

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

	async run(input: string): Promise<InferRunResult<TContract>> {
		return runWorkflowAgent(this, input);
	}
}

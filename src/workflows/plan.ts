import type { WorkflowRegistration } from "../lib/registry.js";
import type { InferWorkflowResult } from "../lib/types.js";
import { Workflow } from "../lib/workflow.js";
import { PlanAgent, type PlanOutput } from "./agents/plan.js";

export class PlanWorkflow extends Workflow<InferWorkflowResult<typeof PlanOutput>> {
	protected async runWorkflow(input: string): Promise<InferWorkflowResult<typeof PlanOutput>> {
		return new PlanAgent().run(input);
	}
}

export const planWorkflow: WorkflowRegistration<InferWorkflowResult<typeof PlanOutput>> = {
	name: "plan",
	description: "Create a read-only implementation plan for the current project",
	create: () => new PlanWorkflow(),
};

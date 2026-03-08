import type { WorkflowRegistration } from "../lib/registry.js";
import type { InferRunResult } from "../lib/types.js";
import { Workflow } from "../lib/workflow.js";
import { PlanAgent, type PlanContract } from "./agents/plan.js";

export class PlanWorkflow extends Workflow<InferRunResult<typeof PlanContract>> {
	protected async runWorkflow(input: string): Promise<InferRunResult<typeof PlanContract>> {
		return new PlanAgent().run(input);
	}
}

export const planWorkflow: WorkflowRegistration<InferRunResult<typeof PlanContract>> = {
	name: "plan",
	description: "Create a read-only implementation plan for the current project",
	create: () => new PlanWorkflow(),
};

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerWorkflowExtension } from "./extension.js";
import { WorkflowRegistry } from "./lib/registry.js";
import { planWorkflow } from "./workflows/plan.js";

export default function workflowExtension(pi: ExtensionAPI): void {
	const registry = new WorkflowRegistry();
	registry.register(planWorkflow);
	registerWorkflowExtension(pi, registry);
}

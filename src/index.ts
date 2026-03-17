import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerWorkflowExtension } from "./extension.js";
import { WorkflowRegistry } from "./lib/registry.js";
import { discoveryWorkflow } from "./workflows/discovery.js";

export default function workflowExtension(pi: ExtensionAPI): void {
	const registry = new WorkflowRegistry();
	registry.register(discoveryWorkflow);
	registerWorkflowExtension(pi, registry);
}

import type { Workflow } from "./workflow.js";

export interface WorkflowRegistration<TResult = unknown> {
	name: string;
	description?: string;
	create: () => Workflow<TResult>;
}

function normalizeWorkflowName(name: string): string {
	const normalized = name.trim();
	if (normalized.length === 0) {
		throw new Error("Workflow name must not be empty.");
	}
	if (/\s/.test(normalized)) {
		throw new Error(`Workflow name must not contain whitespace: ${name}`);
	}
	return normalized;
}

export class WorkflowRegistry {
	private readonly workflows = new Map<string, WorkflowRegistration<unknown>>();

	register<TResult>(workflow: WorkflowRegistration<TResult>): void {
		const normalizedName = normalizeWorkflowName(workflow.name);
		if (this.workflows.has(normalizedName)) {
			throw new Error(`Workflow already registered: ${normalizedName}`);
		}
		this.workflows.set(normalizedName, {
			name: normalizedName,
			description: workflow.description?.trim() || undefined,
			create: workflow.create as () => Workflow<unknown>,
		});
	}

	get(name: string): WorkflowRegistration<unknown> | undefined {
		return this.workflows.get(name);
	}

	list(): WorkflowRegistration<unknown>[] {
		return [...this.workflows.values()].sort((left, right) => left.name.localeCompare(right.name));
	}
}

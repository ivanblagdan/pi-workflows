import type { ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import type {
	WorkflowFeedbackArtifactEvent,
	WorkflowFeedbackEvent,
	WorkflowFeedbackNoteEvent,
	WorkflowFeedbackProgress,
	WorkflowFeedbackSink,
	WorkflowFeedbackScopeKind,
} from "./lib/feedback.js";

const WORKFLOW_FEEDBACK_STATUS_KEY = "workflow";
const WORKFLOW_FEEDBACK_WIDGET_KEY = "workflow-feedback";

interface WorkflowFeedbackScopeState {
	id: string;
	parentId?: string;
	kind: WorkflowFeedbackScopeKind;
	label: string;
	status: "running" | "success" | "error";
	startedAt: number;
	endedAt?: number;
	durationMs?: number;
	latestMessage?: string;
	progress?: WorkflowFeedbackProgress;
	error?: string;
	summary?: string;
	children: string[];
	order: number;
}

interface WorkflowFeedbackStore {
	scopes: Map<string, WorkflowFeedbackScopeState>;
	rootIds: string[];
	latestNote?: WorkflowFeedbackNoteEvent;
	latestArtifact?: WorkflowFeedbackArtifactEvent;
	sequence: number;
}

export interface WorkflowFeedbackController {
	sink: WorkflowFeedbackSink;
	dispose(): void;
}

function formatDuration(durationMs: number): string {
	if (durationMs < 1000) {
		return `${durationMs}ms`;
	}
	return `${(durationMs / 1000).toFixed(1)}s`;
}

function formatPreview(text: string, maxLength: number): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) {
		return normalized;
	}
	return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function formatProgress(progress: WorkflowFeedbackProgress | undefined): string | undefined {
	if (!progress) {
		return undefined;
	}
	return `${progress.completed}/${progress.total}`;
}

function getRunningScopes(store: WorkflowFeedbackStore, kind?: WorkflowFeedbackScopeKind): WorkflowFeedbackScopeState[] {
	return [...store.scopes.values()]
		.filter((scope) => scope.status === "running" && (kind ? scope.kind === kind : true))
		.sort((left, right) => left.order - right.order);
}

function getNewestRunningScope(
	store: WorkflowFeedbackStore,
	kind?: WorkflowFeedbackScopeKind,
): WorkflowFeedbackScopeState | undefined {
	const scopes = getRunningScopes(store, kind);
	return scopes.length > 0 ? scopes[scopes.length - 1] : undefined;
}

function getPrimaryRootScope(store: WorkflowFeedbackStore): WorkflowFeedbackScopeState | undefined {
	for (let index = store.rootIds.length - 1; index >= 0; index--) {
		const scope = store.scopes.get(store.rootIds[index]);
		if (scope) {
			return scope;
		}
	}
	return undefined;
}

function buildStatusText(store: WorkflowFeedbackStore): string | undefined {
	const root = getPrimaryRootScope(store);
	if (!root) {
		return undefined;
	}

	const runningStep = getNewestRunningScope(store, "step");
	const runningTools = getRunningScopes(store, "tool");
	const runningAgents = getRunningScopes(store, "agent");
	const focusLabel = runningStep?.label
		?? (runningTools.length === 1 ? runningTools[0].label : undefined)
		?? (runningTools.length > 1 ? `${runningTools.length} tools active` : undefined)
		?? (runningAgents.length === 1 ? runningAgents[0].label : undefined)
		?? (runningAgents.length > 1 ? `${runningAgents.length} agents active` : undefined)
		?? root.latestMessage;
	const progress = runningStep?.progress
		?? getNewestRunningScope(store)?.progress
		?? root.progress;

	let text = `workflow: ${root.label}`;
	if (focusLabel && focusLabel !== root.label) {
		text += ` → ${focusLabel}`;
	}
	const progressText = formatProgress(progress);
	if (progressText) {
		text += ` (${progressText})`;
	}
	if (store.latestNote?.level === "error") {
		text += ` — ${formatPreview(store.latestNote.message, 48)}`;
	}
	return text;
}

function buildWidgetLines(store: WorkflowFeedbackStore): string[] | undefined {
	const root = getPrimaryRootScope(store);
	if (!root) {
		return undefined;
	}

	const lines: string[] = [];
	lines.push(`[workflow] ${root.label}`);

	const runningStep = getNewestRunningScope(store, "step");
	if (runningStep) {
		const progressText = formatProgress(runningStep.progress);
		lines.push(progressText ? `Step: ${runningStep.label} (${progressText})` : `Step: ${runningStep.label}`);
	}

	const runningAgents = getRunningScopes(store, "agent");
	if (runningAgents.length === 1) {
		lines.push(`Agent: ${runningAgents[0].label}`);
	} else if (runningAgents.length > 1) {
		lines.push(`Agents: ${runningAgents.length} running`);
	}

	const runningTools = getRunningScopes(store, "tool");
	if (runningTools.length === 1) {
		lines.push(`Tool: ${runningTools[0].label}`);
	} else if (runningTools.length > 1) {
		lines.push(`Tools: ${runningTools.length} running`);
	}

	if (store.latestNote) {
		lines.push(`Note: ${formatPreview(store.latestNote.message, 96)}`);
	}

	if (store.latestArtifact) {
		lines.push(`Artifact: ${store.latestArtifact.label}`);
	}

	if (root.status !== "running" && typeof root.durationMs === "number") {
		lines.push(`Finished in ${formatDuration(root.durationMs)}`);
	}

	return lines;
}

function applyFeedbackEvent(store: WorkflowFeedbackStore, event: WorkflowFeedbackEvent): void {
	switch (event.type) {
		case "start": {
			const scope: WorkflowFeedbackScopeState = {
				id: event.scope.id,
				parentId: event.scope.parentId,
				kind: event.scope.kind,
				label: event.scope.label,
				status: "running",
				startedAt: event.timestamp,
				children: [],
				order: store.sequence++,
			};
			store.scopes.set(scope.id, scope);
			if (scope.parentId) {
				store.scopes.get(scope.parentId)?.children.push(scope.id);
			} else {
				store.rootIds.push(scope.id);
			}
			return;
		}
		case "update": {
			const scope = store.scopes.get(event.scopeId);
			if (!scope) {
				return;
			}
			if (event.message !== undefined) {
				scope.latestMessage = event.message;
			}
			if (event.progress !== undefined) {
				scope.progress = event.progress;
			}
			return;
		}
		case "finish": {
			const scope = store.scopes.get(event.scopeId);
			if (!scope) {
				return;
			}
			scope.status = event.status;
			scope.endedAt = event.timestamp;
			scope.durationMs = event.durationMs;
			scope.summary = event.summary;
			scope.error = event.error;
			return;
		}
		case "artifact": {
			store.latestArtifact = event;
			return;
		}
		case "note": {
			store.latestNote = event;
			return;
		}
		default:
			return;
	}
}

export function createWorkflowFeedbackController(options: {
	ui: ExtensionUIContext;
}): WorkflowFeedbackController {
	const store: WorkflowFeedbackStore = {
		scopes: new Map(),
		rootIds: [],
		sequence: 0,
	};

	const render = () => {
		options.ui.setStatus(WORKFLOW_FEEDBACK_STATUS_KEY, buildStatusText(store));
		options.ui.setWidget(WORKFLOW_FEEDBACK_WIDGET_KEY, buildWidgetLines(store), { placement: "aboveEditor" });
	};

	return {
		sink: {
			emit(event) {
				applyFeedbackEvent(store, event);
				render();
			},
		},
		dispose() {
			options.ui.setStatus(WORKFLOW_FEEDBACK_STATUS_KEY, undefined);
			options.ui.setWidget(WORKFLOW_FEEDBACK_WIDGET_KEY, undefined, { placement: "aboveEditor" });
		},
	};
}

import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import type { CreateAgentSessionOptions, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import type { Static } from "@sinclair/typebox";
import type { ArtifactWorkflowOutput, JsonWorkflowOutput, WorkflowOutput } from "./outputs.js";

export type InheritMode = false | "project" | "user" | "both";

export interface WorkflowEnvironment {
	settings?: {
		isolated?: boolean;
	};
	contextFiles?: {
		inherit?: InheritMode;
		files?: Array<{ path: string; content: string }>;
	};
	extensions?: {
		inherit?: InheritMode;
		paths?: string[];
		factories?: ExtensionFactory[];
	};
	skills?: {
		inherit?: InheritMode;
		paths?: string[];
	};
	promptTemplates?: {
		inherit?: InheritMode;
		paths?: string[];
	};
	themes?: {
		inherit?: InheritMode;
		paths?: string[];
	};
}

export interface ResolvedWorkflowEnvironment {
	settings: {
		isolated: boolean;
	};
	contextFiles: {
		inherit: InheritMode;
		files: Array<{ path: string; content: string }>;
	};
	extensions: {
		inherit: InheritMode;
		paths: string[];
		factories: ExtensionFactory[];
	};
	skills: {
		inherit: InheritMode;
		paths: string[];
	};
	promptTemplates: {
		inherit: InheritMode;
		paths: string[];
	};
	themes: {
		inherit: InheritMode;
		paths: string[];
	};
}

export interface WorkflowValidationContext {
	cwd: string;
	input: string;
	attempt: number;
	retriesRemaining: number;
}

export interface WorkflowInvocation {
	name: string;
	input: string;
}

export type WorkflowInvoker = (invocation: WorkflowInvocation) => string;

export type JsonWorkflowResult<TOutput> = {
	output: TOutput;
	response: string;
	outputPath?: never;
};

export type ArtifactWorkflowResult = {
	outputPath: string;
	response: string;
	output?: never;
};

export type InferWorkflowResult<TOutput extends WorkflowOutput> = TOutput extends JsonWorkflowOutput<infer TSchema>
	? JsonWorkflowResult<Static<TSchema>>
	: TOutput extends ArtifactWorkflowOutput
		? ArtifactWorkflowResult
		: never;

export type WorkflowValidator<TResult> = (result: TResult, ctx: WorkflowValidationContext) => void | Promise<void>;

export interface WorkflowAgentRuntimeConfig<TOutput extends WorkflowOutput> {
	instructions: (input: string) => string;
	output: TOutput;
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
	tools?: CreateAgentSessionOptions["tools"];
	cwd?: string;
	retries: number;
	environment: WorkflowEnvironment;
	getValidators(): readonly WorkflowValidator<InferWorkflowResult<TOutput>>[];
}

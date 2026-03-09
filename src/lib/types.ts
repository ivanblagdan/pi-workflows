import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import type { CreateAgentSessionOptions, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import type { Static } from "@sinclair/typebox";
import type { ArtifactWorkflowContract, JsonWorkflowContract, WorkflowContract } from "./contracts.js";

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

export type JsonRunResult<TOutput> = {
	output: TOutput;
	response: string;
	outputPath?: never;
};

export type ArtifactRunResult = {
	outputPath: string;
	response: string;
	output?: never;
};

export type InferRunResult<TContract extends WorkflowContract> = TContract extends JsonWorkflowContract<infer TSchema>
	? JsonRunResult<Static<TSchema>>
	: TContract extends ArtifactWorkflowContract
		? ArtifactRunResult
		: never;

export type WorkflowValidator<TResult> = (result: TResult, ctx: WorkflowValidationContext) => void | Promise<void>;

export interface WorkflowAgentRuntimeConfig<TContract extends WorkflowContract> {
	instructions: (input: string) => string;
	contract: TContract;
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
	tools?: CreateAgentSessionOptions["tools"];
	cwd?: string;
	retries: number;
	environment: WorkflowEnvironment;
	getValidators(): readonly WorkflowValidator<InferRunResult<TContract>>[];
}

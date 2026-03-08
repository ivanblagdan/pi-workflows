import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import {
	DefaultPackageManager,
	DefaultResourceLoader,
	getAgentDir,
	type LoadExtensionsResult,
	type PathMetadata,
	type ResourceDiagnostic,
	type ResourceLoader,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";
import type { InheritMode, ResolvedWorkflowEnvironment, WorkflowEnvironment } from "./types.js";

function dedupeStrings(values: string[]): string[] {
	return [...new Set(values)];
}

function isUnderPath(target: string, root: string): boolean {
	const normalizedTarget = resolve(target);
	const normalizedRoot = resolve(root);
	if (normalizedTarget === normalizedRoot) {
		return true;
	}
	const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
	return normalizedTarget.startsWith(prefix);
}

function normalizeConfiguredPath(path: string): string {
	if (path === "~") {
		return process.env.HOME ?? path;
	}
	if (path.startsWith("~/")) {
		return join(process.env.HOME ?? "~", path.slice(2));
	}
	return path;
}

function resolveConfiguredPaths(paths: string[], cwd: string): string[] {
	return paths.map((value) => resolve(cwd, normalizeConfiguredPath(value)));
}

function allowsScope(inherit: InheritMode, scope: "user" | "project"): boolean {
	if (inherit === false) return false;
	if (inherit === "both") return true;
	return inherit === scope;
}

function normalizeEnvironment(environment: WorkflowEnvironment | undefined): ResolvedWorkflowEnvironment {
	return {
		settings: {
			isolated: environment?.settings?.isolated ?? true,
		},
		contextFiles: {
			inherit: environment?.contextFiles?.inherit ?? "project",
			files: environment?.contextFiles?.files ?? [],
		},
		extensions: {
			inherit: environment?.extensions?.inherit ?? false,
			paths: environment?.extensions?.paths ?? [],
			factories: environment?.extensions?.factories ?? [],
		},
		skills: {
			inherit: environment?.skills?.inherit ?? false,
			paths: environment?.skills?.paths ?? [],
		},
		promptTemplates: {
			inherit: environment?.promptTemplates?.inherit ?? false,
			paths: environment?.promptTemplates?.paths ?? [],
		},
		themes: {
			inherit: environment?.themes?.inherit ?? false,
			paths: environment?.themes?.paths ?? [],
		},
	};
}

class WorkflowResourceLoader implements ResourceLoader {
	private readonly explicitSkillPaths: string[];
	private readonly explicitPromptPaths: string[];
	private readonly explicitThemePaths: string[];

	constructor(
		private readonly base: ResourceLoader,
		private readonly cwd: string,
		private readonly agentDir: string,
		private readonly environment: ResolvedWorkflowEnvironment,
		private readonly appendSystemPrompt: string,
	) {
		this.explicitSkillPaths = resolveConfiguredPaths(environment.skills.paths, cwd);
		this.explicitPromptPaths = resolveConfiguredPaths(environment.promptTemplates.paths, cwd);
		this.explicitThemePaths = resolveConfiguredPaths(environment.themes.paths, cwd);
	}

	getExtensions(): LoadExtensionsResult {
		return this.base.getExtensions();
	}

	getSkills() {
		const result = this.base.getSkills();
		const metadata = this.base.getPathMetadata();
		const skills = result.skills.filter((skill) =>
			this.shouldIncludePathResource(skill.filePath, metadata, {
				inherit: this.environment.skills.inherit,
				explicitPaths: this.explicitSkillPaths,
				fallbackScope:
					skill.source === "user" || skill.source === "project"
						? skill.source
						: skill.source === "path"
							? undefined
							: undefined,
			}),
		);
		const diagnostics = this.filterDiagnostics(result.diagnostics, metadata, {
			inherit: this.environment.skills.inherit,
			explicitPaths: this.explicitSkillPaths,
		});
		return { skills, diagnostics };
	}

	getPrompts() {
		const result = this.base.getPrompts();
		const metadata = this.base.getPathMetadata();
		const prompts = result.prompts.filter((prompt) =>
			this.shouldIncludePathResource(prompt.filePath, metadata, {
				inherit: this.environment.promptTemplates.inherit,
				explicitPaths: this.explicitPromptPaths,
				fallbackScope:
					prompt.source === "user" || prompt.source === "project"
						? prompt.source
						: prompt.source === "path"
							? undefined
							: undefined,
			}),
		);
		const diagnostics = this.filterDiagnostics(result.diagnostics, metadata, {
			inherit: this.environment.promptTemplates.inherit,
			explicitPaths: this.explicitPromptPaths,
		});
		return { prompts, diagnostics };
	}

	getThemes() {
		const result = this.base.getThemes();
		const metadata = this.base.getPathMetadata();
		const themes = result.themes.filter((theme) => {
			if (!theme.sourcePath) {
				return this.environment.themes.inherit !== false;
			}
			return this.shouldIncludePathResource(theme.sourcePath, metadata, {
				inherit: this.environment.themes.inherit,
				explicitPaths: this.explicitThemePaths,
				fallbackScope: this.inferScopeFromPath(theme.sourcePath),
			});
		});
		const diagnostics = this.filterDiagnostics(result.diagnostics, metadata, {
			inherit: this.environment.themes.inherit,
			explicitPaths: this.explicitThemePaths,
		});
		return { themes, diagnostics };
	}

	getAgentsFiles() {
		const filtered = this.base
			.getAgentsFiles()
			.agentsFiles.filter((file) => this.shouldIncludeContextFile(file.path));
		return {
			agentsFiles: [...filtered, ...this.environment.contextFiles.files],
		};
	}

	getSystemPrompt(): string | undefined {
		return this.base.getSystemPrompt();
	}

	getAppendSystemPrompt(): string[] {
		return [...this.base.getAppendSystemPrompt(), this.appendSystemPrompt];
	}

	getPathMetadata(): Map<string, PathMetadata> {
		return this.base.getPathMetadata();
	}

	extendResources(paths: Parameters<ResourceLoader["extendResources"]>[0]): void {
		this.base.extendResources(paths);
	}

	async reload(): Promise<void> {
		await this.base.reload();
	}

	private shouldIncludeContextFile(filePath: string): boolean {
		const inherit = this.environment.contextFiles.inherit;
		if (inherit === false) {
			return false;
		}
		const isUserFile = isUnderPath(filePath, this.agentDir);
		if (inherit === "both") {
			return true;
		}
		if (inherit === "user") {
			return isUserFile;
		}
		return !isUserFile;
	}

	private inferScopeFromPath(filePath: string): "user" | "project" | undefined {
		if (isUnderPath(filePath, this.agentDir)) {
			return "user";
		}
		if (isUnderPath(filePath, this.cwd)) {
			return "project";
		}
		return undefined;
	}

	private shouldIncludePathResource(
		resourcePath: string,
		metadataMap: Map<string, PathMetadata>,
		options: {
			inherit: InheritMode;
			explicitPaths: string[];
			fallbackScope?: "user" | "project";
		},
	): boolean {
		const resolvedPath = resolve(resourcePath);
		if (options.explicitPaths.some((explicitPath) => isUnderPath(resolvedPath, explicitPath))) {
			return true;
		}

		const metadata = metadataMap.get(resolvedPath) ?? metadataMap.get(resourcePath);
		if (metadata?.scope === "user" || metadata?.scope === "project") {
			return allowsScope(options.inherit, metadata.scope);
		}
		if (metadata?.scope === "temporary") {
			return options.inherit !== false;
		}
		if (options.fallbackScope) {
			return allowsScope(options.inherit, options.fallbackScope);
		}
		return options.inherit !== false;
	}

	private filterDiagnostics(
		diagnostics: ResourceDiagnostic[],
		metadataMap: Map<string, PathMetadata>,
		options: {
			inherit: InheritMode;
			explicitPaths: string[];
		},
	): ResourceDiagnostic[] {
		return diagnostics.filter((diagnostic) => {
			if (!diagnostic.path) {
				return options.inherit !== false || options.explicitPaths.length > 0;
			}
			return this.shouldIncludePathResource(diagnostic.path, metadataMap, options);
		});
	}
}

function buildWorkflowAppendPrompt(instructions: string, outputKind: "json" | "artifact"): string {
	const lines = [
		"Workflow execution rules:",
		"- Complete the task described by the user's prompt.",
		'- Before ending the task, you MUST call the tool "workflow_result" successfully.',
		"- Do not stop until workflow_result has been called with the final result.",
		"- If you are told that validation failed, fix the issue and call workflow_result again if the result changed.",
		"",
		"Agent instructions:",
		instructions.trim(),
	];

	if (outputKind === "artifact") {
		lines.splice(
			4,
			0,
			'- For artifact workflows, workflow_result expects an object like { "path": "relative/or/absolute/path" }.',
		);
	}

	return lines.join("\n");
}

function readOptionalFile(filePath: string | undefined): string | undefined {
	if (!filePath) {
		return undefined;
	}
	try {
		return readFileSync(filePath, "utf-8");
	} catch {
		return undefined;
	}
}

function selectSystemPromptSource(cwd: string, agentDir: string, inherit: InheritMode): string | undefined {
	if (inherit === false) {
		return undefined;
	}
	const projectPath = join(cwd, ".pi", "SYSTEM.md");
	const userPath = join(agentDir, "SYSTEM.md");
	if (inherit === "project") {
		return existsSync(projectPath) ? projectPath : undefined;
	}
	if (inherit === "user") {
		return existsSync(userPath) ? userPath : undefined;
	}
	if (existsSync(projectPath)) {
		return projectPath;
	}
	return existsSync(userPath) ? userPath : undefined;
}

function selectAppendSystemPromptSource(cwd: string, agentDir: string, inherit: InheritMode): string | undefined {
	if (inherit === false) {
		return undefined;
	}
	const projectPath = join(cwd, ".pi", "APPEND_SYSTEM.md");
	const userPath = join(agentDir, "APPEND_SYSTEM.md");
	if (inherit === "project") {
		return existsSync(projectPath) ? projectPath : undefined;
	}
	if (inherit === "user") {
		return existsSync(userPath) ? userPath : undefined;
	}
	if (existsSync(projectPath)) {
		return projectPath;
	}
	return existsSync(userPath) ? userPath : undefined;
}

async function resolveInheritedExtensionPaths(options: {
	cwd: string;
	agentDir: string;
	settingsManager: SettingsManager;
	inherit: InheritMode;
}): Promise<string[]> {
	if (options.inherit === false) {
		return [];
	}

	const packageManager = new DefaultPackageManager({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settingsManager: options.settingsManager,
	});
	const resolved = await packageManager.resolve();
	return dedupeStrings(
		resolved.extensions.flatMap((resource) => {
			if (!resource.enabled) {
				return [];
			}
			if (resource.metadata.scope !== "user" && resource.metadata.scope !== "project") {
				return [];
			}
			if (!allowsScope(options.inherit, resource.metadata.scope)) {
				return [];
			}
			return [resource.path];
		}),
	);
}

export async function createWorkflowRuntimeEnvironment(options: {
	cwd: string;
	instructions: string;
	outputKind: "json" | "artifact";
	environment: WorkflowEnvironment | undefined;
}): Promise<{ cwd: string; settingsManager: SettingsManager; resourceLoader: ResourceLoader }> {
	const cwd = options.cwd;
	const agentDir = getAgentDir();
	const environment = normalizeEnvironment(options.environment);
	const settingsManager = environment.settings.isolated
		? SettingsManager.inMemory()
		: SettingsManager.create(cwd, agentDir);
	const inheritedExtensionPaths = await resolveInheritedExtensionPaths({
		cwd,
		agentDir,
		settingsManager,
		inherit: environment.extensions.inherit,
	});

	const selectedSystemPrompt = readOptionalFile(
		selectSystemPromptSource(cwd, agentDir, environment.contextFiles.inherit),
	);
	const selectedAppendSystemPrompt = readOptionalFile(
		selectAppendSystemPromptSource(cwd, agentDir, environment.contextFiles.inherit),
	);

	const baseLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		systemPromptOverride: () => selectedSystemPrompt,
		appendSystemPromptOverride: () => (selectedAppendSystemPrompt ? [selectedAppendSystemPrompt] : []),
		noExtensions: true,
		additionalExtensionPaths: [...inheritedExtensionPaths, ...environment.extensions.paths],
		extensionFactories: environment.extensions.factories,
		noSkills: environment.skills.inherit === false,
		additionalSkillPaths: environment.skills.paths,
		noPromptTemplates: environment.promptTemplates.inherit === false,
		additionalPromptTemplatePaths: environment.promptTemplates.paths,
		noThemes: environment.themes.inherit === false,
		additionalThemePaths: environment.themes.paths,
	});

	const resourceLoader = new WorkflowResourceLoader(
		baseLoader,
		cwd,
		agentDir,
		environment,
		buildWorkflowAppendPrompt(options.instructions, options.outputKind),
	);
	await resourceLoader.reload();

	return {
		cwd,
		settingsManager,
		resourceLoader,
	};
}

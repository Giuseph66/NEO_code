/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { generateUuid } from '../../../../base/common/uuid.js';
import {
	DEFAULT_COMMAND_SEEDS,
	DEFAULT_HOOK_SEEDS,
	DEFAULT_PERSONALITY_SEEDS,
	DEFAULT_SKILL_SEEDS
} from './neocodeSwarmCapabilityCatalog.js';

export const NEO_SWARM_STORAGE_KEY = 'neocode.swarm.config.v1';
export const NEO_SWARM_OPEN_SETTINGS_COMMAND_ID = 'neocode.openSwarmSettings';
export const NEO_SWARM_CLI_CONSENT_STORAGE_KEY = 'neocode.swarm.cliConsent';

export type NeocodeSwarmProviderType = 'gemini' | 'openai' | 'anthropic' | 'custom' | 'qwen-code';
export type NeocodeSwarmAuthMethod = 'apiKey' | 'login' | 'cliToken' | 'qwen-oauth';
export type NeocodeSwarmProviderStatus = 'connected' | 'notConfigured' | 'error';
export type NeocodeSwarmAgentMode = 'parallel' | 'serial';
export type NeocodeSwarmAgentRole = 'planner' | 'coder' | 'reviewer' | 'researcher' | 'debugger' | 'custom';
export type NeocodeSwarmRoutingStrategy = 'orchestratorDecides' | 'fixedByRole' | 'priorityFallback';
export type NeocodeSwarmSkillType = 'terminal' | 'filesystem' | 'search' | 'codebase' | 'custom';

export interface INeocodeSwarmSkillConfig {
	id: string;
	name: string;
	type: NeocodeSwarmSkillType;
	description?: string;
	instructionPath?: string;
}

export interface INeocodeSwarmPersonalityConfig {
	id: string;
	name: string;
	description?: string;
	soulRule: string;
	sourcePath?: string;
}

export interface INeocodeSwarmHookConfig {
	id: string;
	name: string;
	description?: string;
	scriptPath?: string;
}

export interface INeocodeSwarmCommandConfig {
	id: string;
	name: string;
	description?: string;
	executablePath?: string;
}

export interface INeocodeSwarmCapabilitiesConfig {
	personalities: INeocodeSwarmPersonalityConfig[];
	skills: INeocodeSwarmSkillConfig[];
	hooks: INeocodeSwarmHookConfig[];
	commands: INeocodeSwarmCommandConfig[];
}

export interface INeocodeSwarmProviderConfig {
	id: string;
	name: string;
	type: NeocodeSwarmProviderType;
	authMethod: NeocodeSwarmAuthMethod;
	enabled: boolean;
	baseUrl?: string;
	models: string[];
	selectedModel?: string;
	soulRule?: string;
	status?: NeocodeSwarmProviderStatus;
	statusMessage?: string;
	lastConnectionTestAt?: number;
	cliAuthEnabled?: boolean;
}

export interface INeocodeSwarmOrchestratorConfig {
	providerId?: string;
	model?: string;
	temperature?: number;
	maxTokens?: number;
	topP?: number;
	frequencyPenalty?: number;
	presencePenalty?: number;
	systemRule?: string;
}

export interface INeocodeSwarmAgentConfig {
	id: string;
	name: string;
	role: NeocodeSwarmAgentRole;
	providerId?: string;
	mode: NeocodeSwarmAgentMode;
	maxSteps: number;
	maxTokens: number;
	timeoutSeconds: number;
	active: boolean;
	soulRule?: string;
	skills?: INeocodeSwarmSkillConfig[];
	personalityIds?: string[];
	skillIds?: string[];
	hookIds?: string[];
	commandIds?: string[];
}

export interface INeocodeSwarmSecurityConfig {
	maskSensitiveLogs: boolean;
	blockCliExecutionWithoutConfirmation: boolean;
}

export interface INeocodeSwarmAdvancedConfig {
	concurrency: number;
	routingStrategy: NeocodeSwarmRoutingStrategy;
	fallbackToNextProvider: boolean;
	saveTraceWithoutSecrets: boolean;
	showEventsPanel: boolean;
	routeAllThroughOrchestrator: boolean;
	allowDirectAgentCommunication: boolean;
	asyncExecution: boolean;
	partitionLargeTasks: boolean;
	skillsDirectory?: string;
	enforceSkills: boolean;
	isDeveloperMode: boolean;
}

export interface INeocodeSwarmConfig {
	version: 1;
	swarmEnabled: boolean;
	providers: INeocodeSwarmProviderConfig[];
	orchestrator: INeocodeSwarmOrchestratorConfig;
	agents: INeocodeSwarmAgentConfig[];
	security: INeocodeSwarmSecurityConfig;
	advanced: INeocodeSwarmAdvancedConfig;
	capabilities: INeocodeSwarmCapabilitiesConfig;
}

export function createDefaultNeocodeSwarmConfig(): INeocodeSwarmConfig {
	return {
		version: 1,
		swarmEnabled: false,
		providers: [
			createDefaultProvider('Gemini', 'gemini', 'login', ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-pro-exp', 'gemini-2.0-flash', 'gemini-2.0-flash-lite-preview-02-05', 'gemini-2.0-flash-thinking-exp', 'gemini-1.5-pro', 'gemini-1.5-flash'], 'gemini-2.5-flash'),
			createDefaultProvider('OpenAI', 'openai', 'login', ['gpt-5.3-codex', 'gpt-5.2-pro', 'gpt-5', 'gpt-4o'], 'gpt-5.3-codex'),
			createDefaultProvider('Anthropic', 'anthropic', 'login', ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-3-5-sonnet-20240620'], 'claude-sonnet-4-6'),
			createDefaultProvider('Qwen Code', 'qwen-code', 'qwen-oauth', ['coder-model', 'vision-model'], 'coder-model')
		],
		orchestrator: {
			providerId: undefined,
			temperature: 0.2,
			maxTokens: 4096,
			topP: 0.9,
			frequencyPenalty: 0,
			presencePenalty: 0,
			systemRule: 'Quebre tarefas grandes em subtarefas, distribua por especialidade e centralize decisoes.'
		},
		agents: [
			createDefaultAgent('Planejador', 'planner'),
			createDefaultAgent('Codificador', 'coder'),
			createDefaultAgent('Revisor', 'reviewer')
		],
		security: {
			maskSensitiveLogs: true,
			blockCliExecutionWithoutConfirmation: true
		},
		advanced: {
			concurrency: 2,
			routingStrategy: 'orchestratorDecides',
			fallbackToNextProvider: true,
			saveTraceWithoutSecrets: false,
			showEventsPanel: false,
			routeAllThroughOrchestrator: true,
			allowDirectAgentCommunication: false,
			asyncExecution: true,
			partitionLargeTasks: true,
			skillsDirectory: '.neocode/skills',
			enforceSkills: true,
			isDeveloperMode: false
		},
		capabilities: createDefaultCapabilitiesConfig()
	};
}

function createDefaultProvider(name: string, type: NeocodeSwarmProviderType, authMethod: NeocodeSwarmAuthMethod, models: string[], selectedModel: string): INeocodeSwarmProviderConfig {
	return {
		id: generateUuid(),
		name,
		type,
		authMethod,
		enabled: true,
		models,
		selectedModel,
		status: 'notConfigured',
		soulRule: ''
	};
}

function createDefaultAgent(name: string, role: NeocodeSwarmAgentRole): INeocodeSwarmAgentConfig {
	return {
		id: generateUuid(),
		name,
		role,
		mode: 'parallel',
		maxSteps: 8,
		maxTokens: 8192,
		timeoutSeconds: 180,
		active: true,
		soulRule: '',
		skills: [],
		personalityIds: [],
		skillIds: [],
		hookIds: [],
		commandIds: []
	};
}

function createDefaultCapabilitiesConfig(): INeocodeSwarmCapabilitiesConfig {
	return {
		personalities: DEFAULT_PERSONALITY_SEEDS.map(seed => ({
			id: generateUuid(),
			name: seed.name,
			description: `${seed.summary} (origem: ${seed.sourcePath})`,
			soulRule: `{{ ${seed.sourcePath} }}`,
			sourcePath: seed.sourcePath
		})),
		skills: DEFAULT_SKILL_SEEDS.map(seed => ({
			id: generateUuid(),
			name: seed.name,
			type: seed.type,
			description: seed.description,
			instructionPath: seed.instructionPath
		})),
		hooks: DEFAULT_HOOK_SEEDS.map(seed => ({
			id: generateUuid(),
			name: seed.name,
			description: seed.description,
			scriptPath: seed.scriptPath
		})),
		commands: DEFAULT_COMMAND_SEEDS.map(seed => ({
			id: generateUuid(),
			name: seed.name,
			description: seed.description,
			executablePath: seed.executablePath
		}))
	};
}

// ── Swarm Orchestration Types ─────────────────────────────────────────────

export interface ISwarmAgentPlan {
	id: string;
	name: string;
	emoji: string;
	role: string;
	task: string;
}

export interface ISwarmExecutionPlan {
	complexity: 'simple' | 'moderate' | 'complex';
	reasoning: string;
	directAnswer?: string;
	agents: ISwarmAgentPlan[];
	needsTimeBudget: boolean;
}

export type SwarmAgentStatus = 'pending' | 'thinking' | 'working' | 'done' | 'error';

export interface ISwarmAgentLogEntry {
	type: 'thinking' | 'tool' | 'message' | 'error';
	content: string;
	timestamp: number;
}

export interface ISwarmAgentState {
	plan: ISwarmAgentPlan;
	status: SwarmAgentStatus;
	logs: ISwarmAgentLogEntry[];
	result?: string;
	error?: string;
}

export interface ISwarmActivitySession {
	sessionId: string;
	plan: ISwarmExecutionPlan;
	agentStates: Map<string, ISwarmAgentState>;
	orchestratorStatus: string;
	startTime: number;
	endTime?: number;
	complete: boolean;
}

export function sanitizeNeocodeSwarmForExport(config: INeocodeSwarmConfig): INeocodeSwarmConfig {
	const clone: INeocodeSwarmConfig = {
		...config,
		providers: config.providers.map(provider => ({
			...provider,
			status: provider.status === 'connected' ? 'notConfigured' : provider.status,
			statusMessage: undefined
		}))
	};
	return clone;
}

export function getProviderSecretKey(providerId: string): string {
	return `neocode.swarm.provider.${providerId}`;
}

export function providerNeedsApiKey(provider: INeocodeSwarmProviderConfig): boolean {
	return provider.authMethod === 'apiKey';
}

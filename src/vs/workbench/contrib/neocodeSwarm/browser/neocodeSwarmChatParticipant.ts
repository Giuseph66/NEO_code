/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { URI } from '../../../../base/common/uri.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { IChatAgentService, IChatAgentImplementation, IChatAgentRequest, IChatAgentResult, IChatAgentHistoryEntry } from '../../../contrib/chat/common/participants/chatAgents.js';
import { IChatProgress, IChatService } from '../../../contrib/chat/common/chatService/chatService.js';
import { ChatAgentLocation, ChatModeKind } from '../../../contrib/chat/common/constants.js';
import { IChatEditingService } from '../../../contrib/chat/common/editing/chatEditingService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { INeocodeSwarmStorageService, INeocodeSwarmSecretService } from '../common/neocodeSwarmStorage.js';
import { INeocodeSwarmConfig, INeocodeSwarmProviderConfig, NeocodeSwarmProviderType } from '../common/neocodeSwarmTypes.js';
import { QwenRuntimeAdapter, IQwenSdkTaskOptions } from '../../neocode/qwen/browser/qwenRuntimeAdapter.js';
import { QwenProtocol } from '../../neocode/qwen/common/qwenTypes.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { NeocodeSwarmToolExecutor, buildCodeEditingSystemPrompt } from './neocodeSwarmToolExecutor.js';

const NEO_PARTICIPANT_ID = 'neocode.swarm';

function providerTypeToProtocol(type: NeocodeSwarmProviderType): QwenProtocol {
	switch (type) {
		case 'gemini': return 'gemini';
		case 'anthropic': return 'anthropic';
		case 'openai': return 'openai';
		case 'qwen-code': return 'openai';
		case 'custom': return 'openai';
	}
}

function providerTypeToEnvVar(type: NeocodeSwarmProviderType): string {
	switch (type) {
		case 'gemini': return 'GEMINI_API_KEY';
		case 'anthropic': return 'ANTHROPIC_API_KEY';
		case 'openai': return 'OPENAI_API_KEY';
		case 'qwen-code': return 'DASHSCOPE_API_KEY';
		case 'custom': return 'CUSTOM_API_KEY';
	}
}

function providerTypeToDefaultBaseUrl(type: NeocodeSwarmProviderType): string {
	switch (type) {
		case 'gemini': return 'https://generativelanguage.googleapis.com/v1beta';
		case 'anthropic': return 'https://api.anthropic.com/v1';
		case 'openai': return 'https://api.openai.com/v1';
		case 'qwen-code': return 'https://dashscope.aliyuncs.com/compatible-mode/v1';
		case 'custom': return '';
	}
}

/**
 * Workbench contribution that registers the NeoCode Swarm as a chat participant (@neo).
 * Routes chat messages to all configured AI providers using QwenRuntimeAdapter,
 * which natively supports OpenAI, Gemini, Anthropic and Qwen protocols.
 */
export class NeocodeSwarmChatParticipant extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.neocodeSwarmChatParticipant';

	private adapter: QwenRuntimeAdapter | undefined;
	private toolExecutor: NeocodeSwarmToolExecutor | undefined;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IChatAgentService private readonly chatAgentService: IChatAgentService,
		@INeocodeSwarmStorageService private readonly storageService: INeocodeSwarmStorageService,
		@INeocodeSwarmSecretService private readonly secretService: INeocodeSwarmSecretService,
		@ILogService private readonly logService: ILogService,
		@IChatEditingService private readonly chatEditingService: IChatEditingService,
		@IChatService private readonly chatService: IChatService,
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
	) {
		super();

		this._register(this.chatAgentService.registerAgent(NEO_PARTICIPANT_ID, {
			id: NEO_PARTICIPANT_ID,
			name: 'neo',
			fullName: localize('neoSwarmParticipant', "NeoCode Swarm"),
			description: localize('neoSwarmParticipantDesc', "Multi-model AI agent swarm. Supports Gemini, OpenAI, Anthropic and Qwen."),
			isCore: true,
			isDynamic: false,
			extensionId: new ExtensionIdentifier('neocode.swarm'),
			extensionVersion: '1.0.0',
			extensionPublisherId: 'neocode',
			extensionDisplayName: 'NeoCode',
			metadata: {
				isSticky: false,
				sampleRequest: localize('neoSwarmSampleRequest', "Analyze this file and suggest improvements"),
			},
			slashCommands: [
				{ name: 'plan', description: localize('neoSwarmPlanCmd', "Plan a task without making changes") },
				{ name: 'edit', description: localize('neoSwarmEditCmd', "Edit files to complete a task") },
				{ name: 'review', description: localize('neoSwarmReviewCmd', "Review code for issues") },
				// Dynamic custom commands from capabilities config
				...this.storageService.load().capabilities?.commands
					.filter(c => c.name && !['plan', 'edit', 'review'].includes(c.name))
					.map(c => ({
						name: c.name.replace(/^[a-z]+-/, ''), // strip provider prefix like "claude-"
						description: c.description ?? c.name,
					})) ?? [],
			],
			locations: [ChatAgentLocation.Chat, ChatAgentLocation.EditorInline],
			modes: [ChatModeKind.Ask, ChatModeKind.Agent],
			disambiguation: [],
		}));

		const impl: IChatAgentImplementation = {
			invoke: (request, progress, history, token) => this.invoke(request, progress, history, token),
		};

		this._register(this.chatAgentService.registerAgentImplementation(NEO_PARTICIPANT_ID, impl));

		this._register(CommandsRegistry.registerCommand('neocode.executeOrchestrator', async (accessor, prompt: string, token?: CancellationToken) => {
			return this.executeOrchestrator(prompt, token ?? CancellationToken.None);
		}));
	}

	private async invoke(
		request: IChatAgentRequest,
		progress: (parts: IChatProgress[]) => void,
		_history: IChatAgentHistoryEntry[],
		token: CancellationToken = CancellationToken.None
	): Promise<IChatAgentResult> {
		const config = this.storageService.load();
		const providers = config.providers.filter(p => p.enabled);

		if (providers.length === 0) {
			progress([{
				kind: 'markdownContent',
				content: new MarkdownString(localize('neoNoProviders', "**NeoCode:** No providers configured. Open **NeoCode: Configurar Enxame de Agentes** to add a provider."))
			}]);
			return {};
		}

		// Prefer orchestrator's provider if configured, otherwise fall back to first enabled
		let provider: INeocodeSwarmProviderConfig | undefined;
		if (config.orchestrator.providerId) {
			provider = providers.find(p => p.id === config.orchestrator.providerId);
		}
		if (!provider) {
			provider = providers[0];
		}

		// Retrieve stored secret (apiKey > loginToken > cliToken)
		const secret = await this.secretService.getProviderSecret(provider.id, 'apiKey')
			?? await this.secretService.getProviderSecret(provider.id, 'loginToken')
			?? await this.secretService.getProviderSecret(provider.id, 'cliToken');

		// Build capability-aware system prompt (personalities + skills listing)
		const systemPrompt = await this.buildCapabilitySystemPrompt(config);

		// Augment prompt based on slash command (built-in or custom from capabilities)
		let prompt = request.message;
		if (request.command) {
			const customCmd = config.capabilities?.commands.find(
				c => c.name === request.command || c.name.endsWith(`-${request.command}`)
			);
			if (customCmd?.executablePath) {
				// Load custom command instructions from its .md file
				const cmdInstructions = await this.loadCapabilityFile(customCmd.executablePath);
				if (cmdInstructions) {
					prompt = `${cmdInstructions}\n\n## User Request\n${prompt}`;
				}
			} else {
				// Built-in commands
				if (request.command === 'plan') {
					prompt = `Plan (do not execute) the following task:\n\n${prompt}`;
				} else if (request.command === 'review') {
					prompt = `Review the following and provide actionable feedback:\n\n${prompt}`;
				} else if (request.command === 'edit') {
					prompt = `Edit files to complete the following task:\n\n${prompt}`;
				}
			}
		}

		// Inject file/selection context from attachments
		const fileContext = this.buildFileContext(request);
		if (fileContext) {
			prompt = `${fileContext}\n\n${prompt}`;
		}

		progress([{
			kind: 'progressMessage',
			content: new MarkdownString(localize('neoRunning', "_Running with {0} ({1})..._", provider.name, provider.selectedModel ?? provider.models[0] ?? ''))
		}]);

		// Try to wire into the chat editing session so external file changes get accept/reject UI
		const editingSession = this.chatEditingService.getEditingSession(request.sessionResource);
		const chatModel = this.chatService.getSession(request.sessionResource);
		const responseModel = chatModel?.getRequests().find(r => r.id === request.requestId)?.response;

		if (editingSession && responseModel) {
			const opId = Date.now();
			const undoStopId = generateUuid();
			const openUris = this.codeEditorService.listCodeEditors()
				.map(editor => editor.getModel()?.uri)
				.filter((uri): uri is URI => uri !== undefined);

			try {
				const startProgress = await editingSession.startExternalEdits(responseModel, opId, openUris, undoStopId);
				progress(startProgress);
				await this.runWithProvider(provider, secret, prompt, systemPrompt, progress, token);
			} catch (error: unknown) {
				const msg = error instanceof Error ? error.message : String(error);
				this.logService.error('[neocode swarm] Chat participant error:', error);
				progress([{
					kind: 'markdownContent',
					content: new MarkdownString(`**NeoCode Error:** ${msg}`)
				}]);
				return { errorDetails: { message: msg } };
			} finally {
				const stopProgress = await editingSession.stopExternalEdits(responseModel, opId);
				progress(stopProgress);
				await editingSession.show();
			}
		} else {
			try {
				await this.runWithProvider(provider, secret, prompt, systemPrompt, progress, token);
			} catch (error: unknown) {
				const msg = error instanceof Error ? error.message : String(error);
				this.logService.error('[neocode swarm] Chat participant error:', error);
				progress([{
					kind: 'markdownContent',
					content: new MarkdownString(`**NeoCode Error:** ${msg}`)
				}]);
				return { errorDetails: { message: msg } };
			}
		}

		return {};
	}

	private async runWithProvider(
		provider: INeocodeSwarmProviderConfig,
		secret: string | undefined,
		prompt: string,
		systemPrompt: string,
		progress: (parts: IChatProgress[]) => void,
		token: CancellationToken = CancellationToken.None
	): Promise<void> {
		const protocol = providerTypeToProtocol(provider.type);
		const envVarName = providerTypeToEnvVar(provider.type);
		const baseUrl = provider.baseUrl ?? providerTypeToDefaultBaseUrl(provider.type);

		const providerConfig = {
			authType: provider.authMethod === 'qwen-oauth' ? 'qwen-oauth' as const : 'apiKey' as const,
			protocol,
			modelId: provider.selectedModel ?? provider.models[0] ?? 'default',
			displayName: provider.name,
			baseUrl,
			envVarName,
		};

		const env: Record<string, string> = {};
		if (secret) {
			env[envVarName] = secret;
		}

		// Lazily create the tool executor (shared across calls)
		if (!this.toolExecutor) {
			this.toolExecutor = this._register(this.instantiationService.createInstance(NeocodeSwarmToolExecutor));
		}

		const sdkOptions: IQwenSdkTaskOptions = {
			prompt,
			includePartialMessages: true,
			permissionMode: 'default',
			// Pass the tool executor so the model can read/write/edit files
			toolExecutor: provider.authMethod !== 'qwen-oauth' ? this.toolExecutor : undefined,
			systemPrompt,
			maxToolCallRounds: 15,
		};

		if (!this.adapter) {
			this.adapter = this._register(this.instantiationService.createInstance(QwenRuntimeAdapter));
		}

		const stream = this.adapter.runTask(providerConfig, { env, maskedEnv: {} }, sdkOptions, token);

		let hasContent = false;
		for await (const chunk of stream) {
			if (token.isCancellationRequested) {
				break;
			}

			if (chunk.type === 'content' && chunk.value) {
				hasContent = true;
				progress([{
					kind: 'markdownContent',
					content: new MarkdownString(chunk.value)
				}]);
			} else if (chunk.type === 'tool_call' && chunk.toolName) {
				progress([{
					kind: 'progressMessage',
					content: new MarkdownString(`_Executando: ${chunk.toolName}_`)
				}]);
			} else if (chunk.type === 'error' && chunk.error) {
				progress([{
					kind: 'markdownContent',
					content: new MarkdownString(`**Erro:** ${chunk.error}`)
				}]);
			}
		}

		if (!hasContent) {
			progress([{
				kind: 'markdownContent',
				content: new MarkdownString(localize('neoNoResponse', "_Provider returned no content._"))
			}]);
		}
	}

	private async executeOrchestrator(prompt: string, token: CancellationToken = CancellationToken.None): Promise<string> {
		const config = this.storageService.load();
		const providers = config.providers.filter(p => p.enabled);

		if (providers.length === 0) {
			throw new Error('No providers configured in NeoCode Swarm.');
		}

		let provider: INeocodeSwarmProviderConfig | undefined;
		if (config.orchestrator.providerId) {
			provider = providers.find(p => p.id === config.orchestrator.providerId);
		}
		if (!provider) {
			provider = providers[0];
		}

		const secret = await this.secretService.getProviderSecret(provider.id, 'apiKey')
			?? await this.secretService.getProviderSecret(provider.id, 'loginToken')
			?? await this.secretService.getProviderSecret(provider.id, 'cliToken');

		const protocol = providerTypeToProtocol(provider.type);
		const envVarName = providerTypeToEnvVar(provider.type);
		const baseUrl = provider.baseUrl ?? providerTypeToDefaultBaseUrl(provider.type);

		const providerConfig = {
			authType: provider.authMethod === 'qwen-oauth' ? 'qwen-oauth' as const : 'apiKey' as const,
			protocol,
			modelId: provider.selectedModel ?? provider.models[0] ?? 'default',
			displayName: provider.name,
			baseUrl,
			envVarName,
		};

		const env: Record<string, string> = {};
		if (secret) {
			env[envVarName] = secret;
		}

		// Prepend system rule if configured for orchestrator
		let finalPrompt = prompt;
		if (config.orchestrator.systemRule) {
			finalPrompt = `System Rule: ${config.orchestrator.systemRule}\n\nTask:\n${prompt}`;
		}

		if (!this.toolExecutor) {
			this.toolExecutor = this._register(this.instantiationService.createInstance(NeocodeSwarmToolExecutor));
		}

		const orchestratorSystemPrompt = await this.buildCapabilitySystemPrompt(config);

		const sdkOptions: IQwenSdkTaskOptions = {
			prompt: finalPrompt,
			includePartialMessages: false,
			permissionMode: 'default',
			toolExecutor: provider.authMethod !== 'qwen-oauth' ? this.toolExecutor : undefined,
			systemPrompt: orchestratorSystemPrompt,
			maxToolCallRounds: 15,
		};

		if (!this.adapter) {
			this.adapter = this._register(this.instantiationService.createInstance(QwenRuntimeAdapter));
		}

		const stream = this.adapter.runTask(providerConfig, { env, maskedEnv: {} }, sdkOptions, token);

		let result = '';
		for await (const chunk of stream) {
			if (token.isCancellationRequested) {
				break;
			}
			if (chunk.type === 'content' && chunk.value) {
				result += chunk.value;
			} else if (chunk.type === 'error' && chunk.error) {
				throw new Error(chunk.error);
			}
		}

		return result;
	}

	// ─── Capability system prompt ────────────────────────────────────────────

	/**
	 * Builds the full system prompt including:
	 * - Base code-editing instructions (workspace + tools description)
	 * - Active personalities (soulRules from Capabilities tab)
	 * - Listing of available skills (names + paths for on-demand reading)
	 * - Custom commands listing
	 */
	private async buildCapabilitySystemPrompt(config: INeocodeSwarmConfig): Promise<string> {
		const workspaceRoot = this.workspaceService.getWorkspace().folders[0]?.uri.fsPath ?? '';
		const parts: string[] = [buildCodeEditingSystemPrompt(workspaceRoot)];

		// --- Personalities ---
		const personalities = config.capabilities?.personalities ?? [];
		const personalityParts: string[] = [];
		for (const p of personalities) {
			const rule = await this.resolvePersonalityRule(p.soulRule, p.sourcePath);
			if (rule?.trim()) {
				personalityParts.push(`### ${p.name}\n${rule.trim()}`);
			}
		}
		if (personalityParts.length > 0) {
			parts.push(`## Behavioral Guidelines (Active Personalities)\n${personalityParts.join('\n\n')}`);
		}

		// --- Skills (listing only; agent can use read_file to load full content) ---
		const skills = config.capabilities?.skills ?? [];
		if (skills.length > 0) {
			const lines = skills.map(s => {
				const path = s.instructionPath ? ` — load instructions with: read_file("${s.instructionPath}")` : '';
				return `- **${s.name}** (${s.type}): ${s.description ?? ''}${path}`;
			});
			parts.push(`## Available Skills\nUse read_file to load a skill's full instructions when relevant:\n${lines.join('\n')}`);
		}

		// --- Custom commands listing ---
		const commands = config.capabilities?.commands ?? [];
		if (commands.length > 0) {
			const lines = commands.map(c => `- /${c.name}: ${c.description ?? ''}`);
			parts.push(`## Custom Commands\n${lines.join('\n')}`);
		}

		return parts.join('\n\n');
	}

	/**
	 * Resolves a personality soulRule, handling the `{{ path }}` template syntax
	 * that references a file whose content should be loaded.
	 */
	private async resolvePersonalityRule(soulRule: string, sourcePath?: string): Promise<string | undefined> {
		if (!soulRule?.trim()) {
			return undefined;
		}

		// Template syntax: {{ path/to/file.md }}
		const templateMatch = /^\{\{\s*(.+?)\s*\}\}$/.exec(soulRule.trim());
		const filePath = templateMatch?.[1] ?? sourcePath;

		if (filePath) {
			const content = await this.loadCapabilityFile(filePath);
			if (content) {
				return content;
			}
		}

		return soulRule;
	}

	/**
	 * Loads a capability file (SKILL.md, command .md, hooks.json, etc.)
	 * from a path relative to the workspace root.
	 * Returns undefined if the file cannot be read.
	 */
	private async loadCapabilityFile(relativePath: string): Promise<string | undefined> {
		try {
			const workspaceFolders = this.workspaceService.getWorkspace().folders;
			if (workspaceFolders.length === 0) {
				return undefined;
			}

			const uri = relativePath.startsWith('/')
				? URI.file(relativePath)
				: URI.joinPath(workspaceFolders[0].uri, relativePath);

			const content = await this.fileService.readFile(uri);
			return content.value.toString();
		} catch {
			this.logService.debug(`[neocode swarm] Could not load capability file: ${relativePath}`);
			return undefined;
		}
	}

	// ─── File context ─────────────────────────────────────────────────────────

	/**
	 * Extracts file/selection context from chat request attachments.
	 * Returns a formatted context block, or undefined if no file attachments exist.
	 */
	private buildFileContext(request: IChatAgentRequest): string | undefined {
		const variables = request.variables?.variables;
		if (!variables || variables.length === 0) {
			return undefined;
		}

		const parts: string[] = [];
		for (const entry of variables) {
			if ('uri' in entry && entry.uri) {
				parts.push(`Context file: ${entry.uri.toString()}`);
			} else if ('value' in entry && typeof entry.value === 'string' && entry.value) {
				parts.push(entry.value);
			}
		}

		return parts.length > 0 ? parts.join('\n') : undefined;
	}
}

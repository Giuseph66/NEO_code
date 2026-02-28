/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { IChatAgentService, IChatAgentImplementation, IChatAgentRequest, IChatAgentResult, IChatAgentHistoryEntry } from '../../../contrib/chat/common/participants/chatAgents.js';
import { IChatProgress } from '../../../contrib/chat/common/chatService/chatService.js';
import { ChatAgentLocation, ChatModeKind } from '../../../contrib/chat/common/constants.js';
import { INeocodeSwarmStorageService, INeocodeSwarmSecretService } from '../common/neocodeSwarmStorage.js';
import { INeocodeSwarmProviderConfig, NeocodeSwarmProviderType } from '../common/neocodeSwarmTypes.js';
import { QwenRuntimeAdapter, IQwenSdkTaskOptions } from '../../neocode/qwen/browser/qwenRuntimeAdapter.js';
import { QwenProtocol } from '../../neocode/qwen/common/qwenTypes.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { localize } from '../../../../nls.js';

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

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IChatAgentService private readonly chatAgentService: IChatAgentService,
		@INeocodeSwarmStorageService private readonly storageService: INeocodeSwarmStorageService,
		@INeocodeSwarmSecretService private readonly secretService: INeocodeSwarmSecretService,
		@ILogService private readonly logService: ILogService,
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
			],
			locations: [ChatAgentLocation.Chat, ChatAgentLocation.EditorInline],
			modes: [ChatModeKind.Ask, ChatModeKind.Agent],
			disambiguation: [],
		}));

		const impl: IChatAgentImplementation = {
			invoke: (request, progress, history, token) => this.invoke(request, progress, history, token),
		};

		this._register(this.chatAgentService.registerAgentImplementation(NEO_PARTICIPANT_ID, impl));
	}

	private async invoke(
		request: IChatAgentRequest,
		progress: (parts: IChatProgress[]) => void,
		_history: IChatAgentHistoryEntry[],
		token: CancellationToken
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

		// Augment prompt based on slash command
		let prompt = request.message;
		if (request.command === 'plan') {
			prompt = `Plan (do not execute) the following task:\n\n${prompt}`;
		} else if (request.command === 'review') {
			prompt = `Review the following and provide actionable feedback:\n\n${prompt}`;
		} else if (request.command === 'edit') {
			prompt = `Edit files to complete the following task:\n\n${prompt}`;
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

		try {
			await this.runWithProvider(provider, secret, prompt, progress, token);
		} catch (error: unknown) {
			const msg = error instanceof Error ? error.message : String(error);
			this.logService.error('[neocode swarm] Chat participant error:', error);
			progress([{
				kind: 'markdownContent',
				content: new MarkdownString(`**NeoCode Error:** ${msg}`)
			}]);
			return { errorDetails: { message: msg } };
		}

		return {};
	}

	private async runWithProvider(
		provider: INeocodeSwarmProviderConfig,
		secret: string | undefined,
		prompt: string,
		progress: (parts: IChatProgress[]) => void,
		token: CancellationToken
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

		const sdkOptions: IQwenSdkTaskOptions = {
			prompt,
			includePartialMessages: true,
			permissionMode: 'default',
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

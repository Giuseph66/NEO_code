/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { WorkbenchActionExecutedClassification, WorkbenchActionExecutedEvent } from '../../../../../base/common/actions.js';
import { raceTimeout, timeout } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { toErrorMessage } from '../../../../../base/common/errorMessage.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { Lazy } from '../../../../../base/common/lazy.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { IChannel, ProxyChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../../nls.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import product from '../../../../../platform/product/common/product.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { nullExtensionDescription } from '../../../../services/extensions/common/extensions.js';
import { IStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { createDefaultNeocodeSwarmConfig, INeocodeSwarmConfig, INeocodeSwarmProviderConfig, NEO_SWARM_STORAGE_KEY } from '../../../neocodeSwarm/common/neocodeSwarmTypes.js';
import { INeocodeSwarmSecretService } from '../../../neocodeSwarm/common/neocodeSwarmStorage.js';
import { CountTokensCallback, ILanguageModelToolsService, IPreparedToolInvocation, IToolData, IToolImpl, IToolInvocation, IToolResult, ToolDataSource, ToolProgress } from '../../common/tools/languageModelToolsService.js';
import { IChatAgentHistoryEntry, IChatAgentImplementation, IChatAgentRequest, IChatAgentResult, IChatAgentService } from '../../common/participants/chatAgents.js';
import { ChatEntitlement, ChatEntitlementContext, IChatEntitlementService } from '../../../../services/chat/common/chatEntitlementService.js';
import { ChatModel, ChatRequestModel, IChatRequestModel, IChatRequestVariableData } from '../../common/model/chatModel.js';
import { ChatMode } from '../../common/chatModes.js';
import { ChatRequestAgentPart, ChatRequestToolPart } from '../../common/requestParser/chatParserTypes.js';
import { IChatProgress, IChatService } from '../../common/chatService/chatService.js';
import { IChatRequestToolEntry, IChatRequestVariableEntry, isImplicitVariableEntry } from '../../common/attachments/chatVariableEntries.js';
import { ChatAgentLocation, ChatConfiguration, ChatModeKind } from '../../common/constants.js';
import { ChatMessageRole, ILanguageModelsService } from '../../common/languageModels.js';
import { IGeminiAuthService, NEO_GEMINI_SECRET_API_KEY, NEO_GEMINI_SECRET_GOOGLE_API_KEY, NEO_GEMINI_SECRET_OAUTH_TOKENS } from '../../../neocode/gemini/common/geminiTypes.js';
import { QwenCodeAgentRunner } from '../../../neocodeSwarm/browser/neocodeSwarmQwenCodeRunner.js';
import { IOpenAITokenBundle, isOpenAITokenExpiredOrNearExpiry, parseStoredOpenAITokenBundle, refreshOpenAITokenBundle } from '../../../neocodeSwarm/browser/neocodeSwarmOpenAIOAuthController.js';
import { CHAT_OPEN_ACTION_ID, CHAT_SETUP_ACTION_ID } from '../actions/chatActions.js';
import { ChatViewId, IChatWidgetService } from '../chat.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { ChatViewPane } from '../widgetHosts/viewPane/chatViewPane.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { CodeAction, CodeActionList, Command, NewSymbolName, NewSymbolNameTriggerKind, isLocation } from '../../../../../editor/common/languages.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { IRange, Range } from '../../../../../editor/common/core/range.js';
import { ISelection, Selection } from '../../../../../editor/common/core/selection.js';
import { ResourceMap } from '../../../../../base/common/map.js';
import { CodeActionKind } from '../../../../../editor/contrib/codeAction/common/types.js';
import { ACTION_START as INLINE_CHAT_START } from '../../../inlineChat/common/inlineChat.js';
import { IPosition } from '../../../../../editor/common/core/position.js';
import { IMarker, IMarkerService, MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
import { ChatSetupController } from './chatSetupController.js';
import { ChatSetupAnonymous, ChatSetupStep, IChatSetupResult, maybeEnableAuthExtension, refreshTokens } from './chatSetup.js';
import { ChatSetup } from './chatSetupRunner.js';
import { chatViewsWelcomeRegistry } from '../viewsWelcome/chatViewsWelcome.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IDefaultAccountService } from '../../../../../platform/defaultAccount/common/defaultAccount.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { IOutputService } from '../../../../services/output/common/output.js';
import { IExtensionsWorkbenchService } from '../../../extensions/common/extensions.js';
import { IOpenAIHttpRequestOptions, IOpenAIHttpResponse, IOpenAIRequestService, NEO_SWARM_OPENAI_REQUEST_CHANNEL } from '../../../neocodeSwarm/common/neocodeSwarmOpenAIRequestTypes.js';
import { INeocodeSwarmCliExecOptions, INeocodeSwarmCliExecResult, INeocodeSwarmCliExecService, NEO_SWARM_CLI_EXEC_CHANNEL } from '../../../neocodeSwarm/common/neocodeSwarmCliExecTypes.js';

const defaultChat = {
	extensionId: product.defaultChatAgent?.extensionId ?? '',
	chatExtensionId: product.defaultChatAgent?.chatExtensionId ?? '',
	provider: product.defaultChatAgent?.provider ?? { default: { id: '', name: '' }, enterprise: { id: '', name: '' }, apple: { id: '', name: '' }, google: { id: '', name: '' } },
	outputChannelId: product.defaultChatAgent?.chatExtensionOutputId ?? '',
	outputExtensionStateCommand: product.defaultChatAgent?.chatExtensionOutputExtensionStateCommand ?? '',
};

const ToolsAgentContextKey = ContextKeyExpr.and(
	ContextKeyExpr.equals(`config.${ChatConfiguration.AgentEnabled}`, true),
	ContextKeyExpr.not(`previewFeaturesDisabled`) // Set by extension
);
const OPENAI_API_BASE_URL = 'https://api.openai.com';
const OPENAI_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const OPENAI_HTTP_WORKER_MODULE_ID = 'vs/workbench/contrib/neocodeSwarm/node/neocodeSwarmOpenAIRequestMain';
const SWARM_CLI_EXEC_WORKER_MODULE_ID = 'vs/workbench/contrib/neocodeSwarm/node/neocodeSwarmCliExecMain';
const GEMINI_CODE_ASSIST_BASE_URL = 'https://cloudcode-pa.googleapis.com/v1internal';
const GEMINI_CODE_ASSIST_ENDPOINT = `${GEMINI_CODE_ASSIST_BASE_URL}:generateContent`;
const GEMINI_MAX_OUTPUT_TOKENS_MIN = 1;
const GEMINI_MAX_OUTPUT_TOKENS_MAX = 65536;

interface IUtilityProcessWorkerHandle {
	client: { getChannel(channelName: string): IChannel };
	dispose(): void;
}

interface IUtilityProcessWorkerServiceLike {
	createWorker(process: { moduleId: string; type: string; name: string }): Promise<IUtilityProcessWorkerHandle>;
}

interface IInlineEditContext {
	document: URI;
	selection: ISelection;
	selectedText: string;
}

interface IAttachedCodeContext {
	uri: URI;
	range?: IRange;
	text: string;
	source: string;
}

export class SetupAgent extends Disposable implements IChatAgentImplementation {

	static registerDefaultAgents(instantiationService: IInstantiationService, location: ChatAgentLocation, mode: ChatModeKind, context: ChatEntitlementContext, controller: Lazy<ChatSetupController>): { agent: SetupAgent; disposable: IDisposable } {
		return instantiationService.invokeFunction(accessor => {
			const chatAgentService = accessor.get(IChatAgentService);

			let description;
			if (mode === ChatModeKind.Ask) {
				description = ChatMode.Ask.description.get();
			} else if (mode === ChatModeKind.Edit) {
				description = ChatMode.Edit.description.get();
			} else {
				description = ChatMode.Agent.description.get();
			}

			let id: string;
			switch (location) {
				case ChatAgentLocation.Chat:
					if (mode === ChatModeKind.Ask) {
						id = 'setup.chat';
					} else if (mode === ChatModeKind.Edit) {
						id = 'setup.edits';
					} else {
						id = 'setup.agent';
					}
					break;
				case ChatAgentLocation.Terminal:
					id = 'setup.terminal';
					break;
				case ChatAgentLocation.EditorInline:
					id = 'setup.editor';
					break;
				case ChatAgentLocation.Notebook:
					id = 'setup.notebook';
					break;
			}

			return SetupAgent.doRegisterAgent(instantiationService, chatAgentService, id, localize('defaultAgentName', "Neo Agents"), true, description, location, mode, context, controller);
		});
	}

	static registerBuiltInAgents(instantiationService: IInstantiationService, context: ChatEntitlementContext, controller: Lazy<ChatSetupController>): IDisposable {
		return instantiationService.invokeFunction(accessor => {
			const chatAgentService = accessor.get(IChatAgentService);

			const disposables = new DisposableStore();

			// Register VSCode agent
			const { disposable: vscodeDisposable } = SetupAgent.doRegisterAgent(instantiationService, chatAgentService, 'setup.vscode', 'vscode', false, localize2('vscodeAgentDescription', "Ask questions about VS Code").value, ChatAgentLocation.Chat, ChatModeKind.Agent, context, controller);
			disposables.add(vscodeDisposable);

			// Register workspace agent
			const { disposable: workspaceDisposable } = SetupAgent.doRegisterAgent(instantiationService, chatAgentService, 'setup.workspace', 'workspace', false, localize2('workspaceAgentDescription', "Ask about your workspace").value, ChatAgentLocation.Chat, ChatModeKind.Agent, context, controller);
			disposables.add(workspaceDisposable);

			// Register terminal agent
			const { disposable: terminalDisposable } = SetupAgent.doRegisterAgent(instantiationService, chatAgentService, 'setup.terminal.agent', 'terminal', false, localize2('terminalAgentDescription', "Ask how to do something in the terminal").value, ChatAgentLocation.Chat, ChatModeKind.Agent, context, controller);
			disposables.add(terminalDisposable);

			// Register tools
			disposables.add(SetupTool.registerTool(instantiationService, {
				id: 'setup_tools_createNewWorkspace',
				source: ToolDataSource.Internal,
				icon: Codicon.newFolder,
				displayName: localize('setupToolDisplayName', "New Workspace"),
				modelDescription: 'Scaffold a new workspace in VS Code',
				userDescription: localize('setupToolsDescription', "Scaffold a new workspace in VS Code"),
				canBeReferencedInPrompt: true,
				toolReferenceName: 'new',
				when: ContextKeyExpr.true(),
			}));

			return disposables;
		});
	}

	private static doRegisterAgent(instantiationService: IInstantiationService, chatAgentService: IChatAgentService, id: string, name: string, isDefault: boolean, description: string, location: ChatAgentLocation, mode: ChatModeKind, context: ChatEntitlementContext, controller: Lazy<ChatSetupController>): { agent: SetupAgent; disposable: IDisposable } {
		const disposables = new DisposableStore();
		disposables.add(chatAgentService.registerAgent(id, {
			id,
			name,
			isDefault,
			isCore: true,
			modes: [mode],
			when: mode === ChatModeKind.Agent ? ToolsAgentContextKey?.serialize() : undefined,
			slashCommands: [],
			disambiguation: [],
			locations: [location],
			metadata: { helpTextPrefix: SetupAgent.SETUP_NEEDED_MESSAGE },
			description,
			extensionId: nullExtensionDescription.identifier,
			extensionVersion: undefined,
			extensionDisplayName: nullExtensionDescription.name,
			extensionPublisherId: nullExtensionDescription.publisher
		}));

		const agent = disposables.add(instantiationService.createInstance(SetupAgent, context, controller, location));
		disposables.add(chatAgentService.registerAgentImplementation(id, agent));
		if (mode === ChatModeKind.Agent) {
			chatAgentService.updateAgent(id, { themeIcon: Codicon.tools });
		}

		return { agent, disposable: disposables };
	}

	private static readonly SETUP_NEEDED_MESSAGE = new MarkdownString(localize('settingUpNeoAgentsNeeded', "You need to set up Neo Agents and be signed in to use it."));
	private static readonly TRUST_NEEDED_MESSAGE = new MarkdownString(localize('trustNeeded', "You need to trust this workspace to use Chat."));

	private static readonly CHAT_RETRY_COMMAND_ID = 'workbench.action.chat.retrySetup';
	private static readonly CHAT_SHOW_OUTPUT_COMMAND_ID = 'workbench.action.chat.showOutput';

	private readonly _onUnresolvableError = this._register(new Emitter<void>());
	readonly onUnresolvableError = this._onUnresolvableError.event;

	private readonly pendingForwardedRequests = new ResourceMap<Promise<void>>();

	constructor(
		private readonly context: ChatEntitlementContext,
		private readonly controller: Lazy<ChatSetupController>,
		private readonly location: ChatAgentLocation,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IWorkspaceTrustManagementService private readonly workspaceTrustManagementService: IWorkspaceTrustManagementService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IChatEntitlementService private readonly chatEntitlementService: IChatEntitlementService,
		@IViewsService private readonly viewsService: IViewsService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IOutputService private readonly outputService: IOutputService,
		@IExtensionsWorkbenchService private readonly extensionsWorkbenchService: IExtensionsWorkbenchService,
		@ICommandService private readonly commandService: ICommandService,
		@IStorageService private readonly storageService: IStorageService,
		@INeocodeSwarmSecretService private readonly secretService: INeocodeSwarmSecretService,
		@IFileService private readonly fileService: IFileService,
	) {
		super();

		this.registerCommands();
	}

	private registerCommands(): void {

		// Retry chat command
		this._register(CommandsRegistry.registerCommand(SetupAgent.CHAT_RETRY_COMMAND_ID, async (accessor, sessionResource: URI) => {
			const hostService = accessor.get(IHostService);
			const chatWidgetService = accessor.get(IChatWidgetService);

			const widget = chatWidgetService.getWidgetBySessionResource(sessionResource);
			await widget?.clear();

			hostService.reload();
		}));

		// Show output command: execute extension state command if available, then show output channel
		this._register(CommandsRegistry.registerCommand(SetupAgent.CHAT_SHOW_OUTPUT_COMMAND_ID, async (accessor) => {
			const commandService = accessor.get(ICommandService);

			if (defaultChat.outputExtensionStateCommand) {
				// Command invocation may fail or is blocked by the extension activating
				// so we just don't wait and timeout after a certain time, logging the error if it fails or times out.
				raceTimeout(
					commandService.executeCommand(defaultChat.outputExtensionStateCommand),
					5000,
					() => this.logService.info('[chat setup] Timed out executing extension state command')
				).then(undefined, error => {
					this.logService.info('[chat setup] Failed to execute extension state command', error);
				});
			}

			if (defaultChat.outputChannelId) {
				await commandService.executeCommand(`workbench.action.output.show.${defaultChat.outputChannelId}`);
			}
		}));
	}

	private get swarmConfig(): INeocodeSwarmConfig {
		const raw = this.storageService.get(NEO_SWARM_STORAGE_KEY, StorageScope.PROFILE);
		if (!raw) {
			return createDefaultNeocodeSwarmConfig();
		}

		try {
			return JSON.parse(raw);
		} catch {
			return createDefaultNeocodeSwarmConfig();
		}
	}

	async invoke(request: IChatAgentRequest, progress: (parts: IChatProgress[]) => void, history: IChatAgentHistoryEntry[], token: CancellationToken): Promise<IChatAgentResult> {
		return this.instantiationService.invokeFunction(async accessor /* using accessor for lazy loading */ => {
			const chatService = accessor.get(IChatService);
			const languageModelsService = accessor.get(ILanguageModelsService);
			const chatWidgetService = accessor.get(IChatWidgetService);
			const chatAgentService = accessor.get(IChatAgentService);
			const languageModelToolsService = accessor.get(ILanguageModelToolsService);
			const defaultAccountService = accessor.get(IDefaultAccountService);
			const geminiAuthService = accessor.get(IGeminiAuthService);
			const secretStorageService = accessor.get(ISecretStorageService);

			return this.doInvoke(request, part => progress([part]), chatService, languageModelsService, chatWidgetService, chatAgentService, languageModelToolsService, defaultAccountService, geminiAuthService, secretStorageService, history, token);
		});
	}

	private async doInvoke(request: IChatAgentRequest, progress: (part: IChatProgress) => void, chatService: IChatService, languageModelsService: ILanguageModelsService, chatWidgetService: IChatWidgetService, chatAgentService: IChatAgentService, languageModelToolsService: ILanguageModelToolsService, defaultAccountService: IDefaultAccountService, geminiAuthService: IGeminiAuthService, secretStorageService: ISecretStorageService, history: IChatAgentHistoryEntry[], token: CancellationToken): Promise<IChatAgentResult> {
		const config = this.swarmConfig;
		const needsSetup =
			!this.context.state.installed ||									// Extension not installed: run setup to install
			this.context.state.disabled ||										// Extension disabled: run setup to enable
			this.context.state.untrusted ||										// Workspace untrusted: run setup to ask for trust
			this.context.state.entitlement === ChatEntitlement.Available ||		// Entitlement available: run setup to sign up
			(
				this.context.state.entitlement === ChatEntitlement.Unknown &&	// Entitlement unknown: run setup to sign in / sign up
				!this.chatEntitlementService.anonymous							// unless anonymous access is enabled
			);
		if (config.swarmEnabled) {
			const orchestrator = config.orchestrator;
			const provider = config.providers.find(p => p.id === orchestrator.providerId);
			if (provider?.type === 'qwen-code') {
				return this.doInvokeQwenCode(request, progress, provider, config, history, token);
			}
			if (provider?.type === 'gemini') {
				return this.doInvokeGeminiSwarm(request, progress, provider, config, geminiAuthService, secretStorageService, history, token);
			}

			return this.doInvokeSwarm(request, progress, languageModelsService, geminiAuthService, config, history, token);
		}

		if (needsSetup) {
			return this.doInvokeWithSetup(request, progress, chatService, languageModelsService, chatWidgetService, chatAgentService, languageModelToolsService, defaultAccountService);
		}

		return this.doInvokeWithoutSetup(request, progress, chatService, languageModelsService, chatWidgetService, chatAgentService, languageModelToolsService);
	}

	private async doInvokeSwarm(request: IChatAgentRequest, progress: (part: IChatProgress) => void, languageModelsService: ILanguageModelsService, geminiAuthService: IGeminiAuthService, config: INeocodeSwarmConfig, history: IChatAgentHistoryEntry[], token: CancellationToken): Promise<IChatAgentResult> {
		const orchestrator = config.orchestrator;
		const provider = config.providers.find(p => p.id === orchestrator.providerId);

		if (!provider || !provider.enabled) {
			progress({ kind: 'markdownContent', content: new MarkdownString(localize('swarmProviderNotConfigured', "NeoCode Swarm: Orchestrator provider is not configured or enabled. Please check Swarm Settings.")) });
			return {};
		}

		const selectedModel = orchestrator.model || provider.selectedModel;
		if (!selectedModel) {
			progress({ kind: 'markdownContent', content: new MarkdownString(localize('swarmModelNotConfigured', "NeoCode Swarm: No model selected for orchestrator.")) });
			return {};
		}

		// OpenAI provider:
		// - `apiKey`: call OpenAI API directly (/v1/chat/completions).
		// - `login`: call ChatGPT Codex OAuth backend directly (/backend-api/codex/responses).
		if (provider.type === 'openai') {
			return this.doInvokeOpenAISwarm(request, progress, provider, config, selectedModel, history);
		}
		if (provider.type === 'anthropic') {
			return this.doInvokeAnthropicSwarm(request, progress, provider, config, selectedModel, history);
		}

		// Try to find a matching model in ILanguageModelsService
		const modelIds = languageModelsService.getLanguageModelIds();
		const providerType = provider.type.toLowerCase();
		const targetModelId = modelIds.find(id => {
			const lowerId = id.toLowerCase();
			return lowerId.includes(providerType) && lowerId.includes(selectedModel.toLowerCase());
		}) || modelIds.find(id => id.toLowerCase().includes(selectedModel.toLowerCase())) || modelIds[0];

		if (!targetModelId) {
			progress({ kind: 'markdownContent', content: new MarkdownString(localize('swarmNoModelFound', "NeoCode Swarm: Could not find model '{0}' in available language models.", selectedModel)) });
			return {};
		}

		const inlineEditContext = await this.resolveInlineEditContext(request);
		this.notifyMissingInlineEditContextIfNeeded(request, inlineEditContext, progress);
		progress({ kind: 'progressMessage', content: new MarkdownString(localize('swarmInoking', "NeoCode Swarm: Orchestrating via {0}...", targetModelId)) });

		try {
			const effectiveUserMessage = this.resolveEffectiveUserMessage(request.message, history);
			const contextualUserMessage = await this.buildPromptWithAttachedCodeContext(request, effectiveUserMessage, inlineEditContext);
			const userMessage = inlineEditContext
				? this.buildInlineEditPrompt(contextualUserMessage, inlineEditContext.selectedText)
				: contextualUserMessage;
			const response = await languageModelsService.sendChatRequest(targetModelId, nullExtensionDescription.identifier, [
				{ role: ChatMessageRole.System, content: [{ type: 'text', value: orchestrator.systemRule || '' }] },
				{ role: ChatMessageRole.User, content: [{ type: 'text', value: userMessage }] }
			], {
				temperature: orchestrator.temperature,
				maxTokens: orchestrator.maxTokens
			}, token);

			let responseText = '';
			for await (const part of response.stream) {
				if (Array.isArray(part)) {
					for (const p of part) {
						if (p.type === 'text') {
							responseText += p.value;
							if (!inlineEditContext) {
								progress({ kind: 'markdownContent', content: new MarkdownString(p.value) });
							}
						}
					}
				} else if (part.type === 'text') {
					responseText += part.value;
					if (!inlineEditContext) {
						progress({ kind: 'markdownContent', content: new MarkdownString(part.value) });
					}
				}
			}

			await response.result;
			if (inlineEditContext) {
				await this.handleInlineEditResponse(inlineEditContext, responseText, progress);
			}
			return {};
		} catch (error) {
			this.logService.error('[chat setup] Swarm invocation failed:', error);
			progress({ kind: 'markdownContent', content: new MarkdownString(localize('swarmInvocationError', "NeoCode Swarm error: {0}", toErrorMessage(error))) });
			return {};
		}
	}

	private async doInvokeOpenAISwarm(request: IChatAgentRequest, progress: (part: IChatProgress) => void, provider: INeocodeSwarmProviderConfig, config: INeocodeSwarmConfig, selectedModel: string, history: IChatAgentHistoryEntry[]): Promise<IChatAgentResult> {
		const credential = await this.resolveOpenAICredential(provider);
		if (!credential.ok) {
			progress({ kind: 'markdownContent', content: new MarkdownString(credential.message) });
			return {};
		}

		if (provider.authMethod === 'login') {
			return this.doInvokeOpenAICodexOAuthSwarm(request, progress, provider, config, selectedModel, credential.accessToken, history);
		}

		const baseUrl = normalizeBaseUrl(provider.baseUrl ?? OPENAI_API_BASE_URL);
		const endpoint = `${baseUrl}/v1/chat/completions`;
		progress({ kind: 'progressMessage', content: new MarkdownString(localize('swarmOpenAIInvoking', "NeoCode Swarm: Orchestrating via OpenAI ({0})...", selectedModel)) });

		const orchestrator = config.orchestrator;
		const inlineEditContext = await this.resolveInlineEditContext(request);
		this.notifyMissingInlineEditContextIfNeeded(request, inlineEditContext, progress);
		const effectiveUserMessage = this.resolveEffectiveUserMessage(request.message, history);
		const contextualUserMessage = await this.buildPromptWithAttachedCodeContext(request, effectiveUserMessage, inlineEditContext);
		const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
		const systemRule = orchestrator.systemRule?.trim();
		if (systemRule) {
			messages.push({ role: 'system', content: systemRule });
		}
		const userMessage = inlineEditContext
			? this.buildInlineEditPrompt(contextualUserMessage, inlineEditContext.selectedText)
			: contextualUserMessage;
		messages.push({ role: 'user', content: userMessage });

		const requestBody: Record<string, unknown> = {
			model: selectedModel,
			messages,
			stream: false
		};
		if (typeof orchestrator.temperature === 'number') {
			requestBody.temperature = orchestrator.temperature;
		}
		if (typeof orchestrator.maxTokens === 'number') {
			requestBody.max_tokens = orchestrator.maxTokens;
		}
		if (typeof orchestrator.topP === 'number') {
			requestBody.top_p = orchestrator.topP;
		}
		if (typeof orchestrator.frequencyPenalty === 'number') {
			requestBody.frequency_penalty = orchestrator.frequencyPenalty;
		}
		if (typeof orchestrator.presencePenalty === 'number') {
			requestBody.presence_penalty = orchestrator.presencePenalty;
		}

		try {
			const context = await this.performOpenAIHttpRequest({
				type: 'POST',
				url: endpoint,
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${credential.accessToken}`
				},
				data: JSON.stringify(requestBody)
			});
			const statusCode = context.statusCode;
			const raw = context.body;

			if (statusCode < 200 || statusCode >= 300) {
				const detail = this.readOpenAIErrorDetailFromRaw(raw);
				const message = detail
					? localize('swarmOpenAIInvocationErrorDetailed', "NeoCode Swarm: OpenAI error (HTTP {0}): {1}", statusCode, detail)
					: localize('swarmOpenAIInvocationError', "NeoCode Swarm: OpenAI error (HTTP {0}).", statusCode);
				progress({ kind: 'markdownContent', content: new MarkdownString(message) });
				return {};
			}

			const payload = JSON.parse(raw) as {
				choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
			};
			const choice = payload.choices?.[0];
			const content = choice?.message?.content;
			const text = typeof content === 'string'
				? content.trim()
				: Array.isArray(content)
					? content
						.filter(part => part?.type === 'text' && typeof part.text === 'string')
						.map(part => part.text!.trim())
						.filter(Boolean)
						.join('\n')
					: '';

			if (text) {
				if (inlineEditContext) {
					await this.handleInlineEditResponse(inlineEditContext, text, progress);
				} else {
					progress({ kind: 'markdownContent', content: new MarkdownString(text) });
				}
			} else {
				progress({ kind: 'markdownContent', content: new MarkdownString(localize('swarmOpenAIEmpty', "NeoCode Swarm: OpenAI retornou resposta vazia.")) });
			}
			return {};
		} catch (error) {
			this.logService.error('[chat setup] OpenAI swarm invocation failed:', error);
			progress({
				kind: 'markdownContent',
				content: new MarkdownString(localize('swarmOpenAIGenericFailure', "NeoCode Swarm: falha ao chamar OpenAI: {0}", toErrorMessage(error)))
			});
			return {};
		}
	}

	private async doInvokeAnthropicSwarm(
		request: IChatAgentRequest,
		progress: (part: IChatProgress) => void,
		provider: INeocodeSwarmProviderConfig,
		config: INeocodeSwarmConfig,
		selectedModel: string,
		history: IChatAgentHistoryEntry[]
	): Promise<IChatAgentResult> {
		const orchestrator = config.orchestrator;
		const inlineEditContext = await this.resolveInlineEditContext(request);
		this.notifyMissingInlineEditContextIfNeeded(request, inlineEditContext, progress);
		const effectiveUserMessage = this.resolveEffectiveUserMessage(request.message, history);
		const contextualUserMessage = await this.buildPromptWithAttachedCodeContext(request, effectiveUserMessage, inlineEditContext);
		const userMessage = inlineEditContext
			? this.buildInlineEditPrompt(contextualUserMessage, inlineEditContext.selectedText)
			: contextualUserMessage;
		const systemRule = orchestrator.systemRule?.trim();

		// 1) If login-token exists, use direct Anthropic API (behaves like API key).
		// 2) Otherwise, for login mode, fallback to Claude CLI authenticated session.
		let secretKind: 'apiKey' | 'loginToken' = provider.authMethod === 'apiKey' ? 'apiKey' : 'loginToken';
		let secret = await this.getProviderSecretWithFallback(provider, secretKind);
		if (!secret?.trim() && provider.authMethod === 'login') {
			secretKind = 'apiKey';
			secret = await this.getProviderSecretWithFallback(provider, 'apiKey');
		}

		if (secret?.trim()) {
			return this.invokeAnthropicViaHttp(secret.trim(), selectedModel, systemRule, userMessage, provider, orchestrator.maxTokens, inlineEditContext, progress);
		}

		if (provider.authMethod !== 'login') {
			progress({
				kind: 'markdownContent',
				content: new MarkdownString(localize('swarmAnthropicMissingKey', "NeoCode Swarm: API key Anthropic ausente. Configure em Configurar Enxame."))
			});
			return {};
		}

		const cliCandidates = this.resolveAnthropicCliCandidates();
		const authStatus = await this.getAnthropicCliAuthStatus(cliCandidates);
		if (!authStatus.ok) {
			progress({
				kind: 'markdownContent',
				content: new MarkdownString(authStatus.message)
			});
			return {};
		}

		return this.invokeAnthropicViaCli(authStatus.cliPath, selectedModel, systemRule, userMessage, inlineEditContext, progress);
	}

	private async doInvokeGeminiSwarm(request: IChatAgentRequest, progress: (part: IChatProgress) => void, provider: INeocodeSwarmProviderConfig, config: INeocodeSwarmConfig, geminiAuthService: IGeminiAuthService, secretStorageService: ISecretStorageService, history: IChatAgentHistoryEntry[], token: CancellationToken): Promise<IChatAgentResult> {
		const orchestrator = config.orchestrator;
		const selectedModel = orchestrator.model || provider.selectedModel || 'gemini-2.0-flash';
		progress({ kind: 'progressMessage', content: new MarkdownString(localize('swarmGeminiInvoking', "NeoCode Swarm: Orchestrating via Gemini ({0})...", selectedModel)) });

		const inlineEditContext = await this.resolveInlineEditContext(request);
		this.notifyMissingInlineEditContextIfNeeded(request, inlineEditContext, progress);
		const effectiveUserMessage = this.resolveEffectiveUserMessage(request.message, history);
		const contextualUserMessage = await this.buildPromptWithAttachedCodeContext(request, effectiveUserMessage, inlineEditContext);
		const userMessage = inlineEditContext
			? this.buildInlineEditPrompt(contextualUserMessage, inlineEditContext.selectedText)
			: contextualUserMessage;

		try {
			const geminiConfig = geminiAuthService.loadConfig();
			const systemRule = orchestrator.systemRule?.trim();
			const endpointBase = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(selectedModel)}:generateContent`;
			const requestBody: Record<string, unknown> = {
				contents: [
					{
						role: 'user',
						parts: [{ text: userMessage }]
					}
				]
			};
			if (systemRule) {
				requestBody.systemInstruction = { parts: [{ text: systemRule }] };
			}

			const generationConfig: Record<string, unknown> = {};
			if (typeof orchestrator.temperature === 'number') {
				generationConfig.temperature = orchestrator.temperature;
			}
			if (typeof orchestrator.topP === 'number') {
				generationConfig.topP = orchestrator.topP;
			}
			if (typeof orchestrator.maxTokens === 'number') {
				const boundedMaxTokens = this.boundGeminiMaxOutputTokens(orchestrator.maxTokens);
				if (typeof boundedMaxTokens === 'number') {
					generationConfig.maxOutputTokens = boundedMaxTokens;
				}
			}
			if (Object.keys(generationConfig).length > 0) {
				requestBody.generationConfig = generationConfig;
			}

			let endpoint = endpointBase;
			const headers: Record<string, string> = {
				'Content-Type': 'application/json'
			};
			let usedGoogleLogin = false;
			let apiKeyForFallback: string | undefined;

			if (geminiConfig.authType === 'googleLogin') {
				const tokensRaw = await secretStorageService.get(NEO_GEMINI_SECRET_OAUTH_TOKENS);
				const parsed = tokensRaw ? JSON.parse(tokensRaw) as { accessToken?: string } : {};
				if (!parsed.accessToken) {
					progress({ kind: 'markdownContent', content: new MarkdownString(localize('swarmGeminiNoToken', "NeoCode Swarm: Nenhuma sessao de Login Google encontrada para o Gemini. Faca login na interface.")) });
					return {};
				}
				headers['Authorization'] = `Bearer ${parsed.accessToken}`;
				usedGoogleLogin = true;
				const codeAssistBody: Record<string, unknown> = {
					model: this.toGeminiCodeAssistModelName(selectedModel),
					user_prompt_id: `neocode-${Date.now()}`,
					request: requestBody
				};
				const preferredProject = geminiConfig.googleCloudProject?.trim();
				const codeAssistSetup = await this.resolveGeminiCodeAssistProject(headers, preferredProject, token);
				if (codeAssistSetup.projectId) {
					codeAssistBody['project'] = codeAssistSetup.projectId;
				} else if (preferredProject) {
					codeAssistBody['project'] = preferredProject;
				}
				if (codeAssistSetup.warning) {
					this.logService.warn('[chat setup] Gemini Code Assist setup warning:', codeAssistSetup.warning);
				}
				// Keep available for transparent fallback when OAuth token lacks Gemini scope.
				const preferredKey = geminiConfig.apiKeyVar === 'GOOGLE_API_KEY'
					? await secretStorageService.get(NEO_GEMINI_SECRET_GOOGLE_API_KEY)
					: await secretStorageService.get(NEO_GEMINI_SECRET_API_KEY);
				const secondaryKey = geminiConfig.apiKeyVar === 'GOOGLE_API_KEY'
					? await secretStorageService.get(NEO_GEMINI_SECRET_API_KEY)
					: await secretStorageService.get(NEO_GEMINI_SECRET_GOOGLE_API_KEY);
				apiKeyForFallback = preferredKey?.trim() || secondaryKey?.trim();

				// Gemini CLI's Google Login flow talks to Code Assist endpoint.
				const codeAssistResponse = await fetch(GEMINI_CODE_ASSIST_ENDPOINT, {
					method: 'POST',
					headers,
					body: JSON.stringify(codeAssistBody)
				});

				if (codeAssistResponse.ok) {
					const raw = await codeAssistResponse.text();
					if (token.isCancellationRequested) {
						return {};
					}
					const responseText = this.extractGeminiCodeAssistText(raw);
					if (responseText) {
						if (inlineEditContext) {
							await this.handleInlineEditResponse(inlineEditContext, responseText, progress);
						} else {
							progress({ kind: 'markdownContent', content: new MarkdownString(responseText) });
						}
					} else {
						progress({ kind: 'markdownContent', content: new MarkdownString(localize('swarmGeminiEmpty', "NeoCode Swarm: Gemini retornou resposta vazia.")) });
					}
					return {};
				}

				const codeAssistErrorRaw = await codeAssistResponse.text();
				const codeAssistDetail = this.readGeminiErrorDetailFromRaw(codeAssistErrorRaw) ?? this.readGeminiCodeAssistErrorDetailFromRaw(codeAssistErrorRaw);
				if (codeAssistResponse.status === 403 && (codeAssistDetail?.toLowerCase().includes('insufficient authentication scopes') ?? false) && apiKeyForFallback) {
					this.logService.warn('[chat setup] Gemini Code Assist token missing scopes; retrying with API key fallback');
					endpoint = `${endpointBase}?key=${encodeURIComponent(apiKeyForFallback)}`;
				} else if (codeAssistResponse.status === 403 && (codeAssistDetail?.toLowerCase().includes('insufficient authentication scopes') ?? false)) {
					const message = codeAssistDetail
						? localize('swarmGeminiScopeErrorDetailed', "NeoCode Swarm: Token Google sem escopo para Gemini ({0}). Configure API key Gemini/Google ou refaca login com escopos corretos.", codeAssistDetail)
						: localize('swarmGeminiScopeError', "NeoCode Swarm: Token Google sem escopo para Gemini. Configure API key Gemini/Google ou refaca login com escopos corretos.");
					progress({ kind: 'markdownContent', content: new MarkdownString(message) });
					return {};
				} else if (apiKeyForFallback) {
					this.logService.warn('[chat setup] Gemini Code Assist request failed, retrying with API key fallback:', codeAssistDetail ?? `HTTP ${codeAssistResponse.status}`);
					endpoint = `${endpointBase}?key=${encodeURIComponent(apiKeyForFallback)}`;
				} else {
					const message = codeAssistDetail
						? localize('swarmGeminiInvocationErrorDetailed', "NeoCode Swarm: Gemini error (HTTP {0}): {1}", codeAssistResponse.status, codeAssistDetail)
						: localize('swarmGeminiInvocationError', "NeoCode Swarm: Gemini error (HTTP {0}).", codeAssistResponse.status);
					progress({ kind: 'markdownContent', content: new MarkdownString(message) });
					return {};
				}
			} else {
				const envResult = await geminiAuthService.buildRuntimeEnv();
				const env = envResult.env;
				const apiKey = env['GEMINI_API_KEY'] || env['GOOGLE_API_KEY'];
				if (!apiKey) {
					progress({ kind: 'markdownContent', content: new MarkdownString(localize('swarmGeminiNoKey', "NeoCode Swarm: Nenhuma chave de API configurada. Faca login na interface.")) });
					return {};
				}
				endpoint = `${endpointBase}?key=${encodeURIComponent(apiKey)}`;
			}

			let response = await fetch(endpoint, {
				method: 'POST',
				headers,
				body: JSON.stringify(requestBody)
			});

			// OAuth tokens from generic Google login may not include Gemini API scopes.
			if (usedGoogleLogin && response.status === 403 && !endpoint.includes('?key=')) {
				const raw403 = await response.text();
				const detail403 = this.readGeminiErrorDetailFromRaw(raw403)?.toLowerCase() ?? '';
				if (detail403.includes('insufficient authentication scopes') && apiKeyForFallback) {
					this.logService.warn('[chat setup] Gemini OAuth token missing Gemini scope; retrying with API key fallback');
					response = await fetch(`${endpointBase}?key=${encodeURIComponent(apiKeyForFallback)}`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(requestBody)
					});
				} else {
					const message = detail403
						? localize('swarmGeminiScopeErrorDetailed', "NeoCode Swarm: Token Google sem escopo para Gemini ({0}). Configure API key Gemini/Google ou refaca login com escopos corretos.", detail403)
						: localize('swarmGeminiScopeError', "NeoCode Swarm: Token Google sem escopo para Gemini. Configure API key Gemini/Google ou refaca login com escopos corretos.");
					progress({ kind: 'markdownContent', content: new MarkdownString(message) });
					return {};
				}
			}

			if (!response.ok) {
				const rawError = await response.text();
				const errorDetail = this.readGeminiErrorDetailFromRaw(rawError);
				const message = errorDetail
					? localize('swarmGeminiInvocationErrorDetailed', "NeoCode Swarm: Gemini error (HTTP {0}): {1}", response.status, errorDetail)
					: localize('swarmGeminiInvocationError', "NeoCode Swarm: Gemini error (HTTP {0}).", response.status);
				progress({ kind: 'markdownContent', content: new MarkdownString(message) });
				return {};
			}

			const raw = await response.text();
			if (token.isCancellationRequested) {
				return {};
			}

			const responseText = this.extractGeminiText(raw);
			if (responseText) {
				if (inlineEditContext) {
					await this.handleInlineEditResponse(inlineEditContext, responseText, progress);
				} else {
					progress({ kind: 'markdownContent', content: new MarkdownString(responseText) });
				}
			} else {
				progress({ kind: 'markdownContent', content: new MarkdownString(localize('swarmGeminiEmpty', "NeoCode Swarm: Gemini retornou resposta vazia.")) });
			}

			return {};
		} catch (error) {
			this.logService.error('[chat setup] Gemini swarm invocation failed:', error);
			progress({
				kind: 'markdownContent',
				content: new MarkdownString(localize('swarmGeminiGenericFailure', "NeoCode Swarm: Falha ao chamar Gemini: {0}", toErrorMessage(error)))
			});
			return {};
		}
	}

	private toGeminiCodeAssistModelName(modelName: string): string {
		return modelName.replace(/^models\//i, '');
	}

	private boundGeminiMaxOutputTokens(value: number): number | undefined {
		if (!Number.isFinite(value)) {
			return undefined;
		}

		const integerValue = Math.floor(value);
		if (integerValue < GEMINI_MAX_OUTPUT_TOKENS_MIN) {
			return GEMINI_MAX_OUTPUT_TOKENS_MIN;
		}
		if (integerValue > GEMINI_MAX_OUTPUT_TOKENS_MAX) {
			return GEMINI_MAX_OUTPUT_TOKENS_MAX;
		}
		return integerValue;
	}

	private async resolveGeminiCodeAssistProject(
		headers: Record<string, string>,
		preferredProject: string | undefined,
		token: CancellationToken
	): Promise<{ projectId?: string; warning?: string }> {
		const metadata = this.buildGeminiCodeAssistMetadata(preferredProject);
		const loadPayload: Record<string, unknown> = { metadata };
		if (preferredProject) {
			loadPayload['cloudaicompanionProject'] = preferredProject;
		}

		try {
			const loadResponse = await fetch(`${GEMINI_CODE_ASSIST_BASE_URL}:loadCodeAssist`, {
				method: 'POST',
				headers,
				body: JSON.stringify(loadPayload)
			});
			const loadRaw = await loadResponse.text();
			if (!loadResponse.ok) {
				const detail = this.readGeminiCodeAssistErrorDetailFromRaw(loadRaw) ?? this.readGeminiErrorDetailFromRaw(loadRaw);
				return { warning: detail ?? `loadCodeAssist failed with HTTP ${loadResponse.status}` };
			}

			const load = JSON.parse(loadRaw) as {
				currentTier?: { id?: string };
				allowedTiers?: Array<{ id?: string; isDefault?: boolean }>;
				cloudaicompanionProject?: string | null;
			};
			const projectFromLoad = typeof load.cloudaicompanionProject === 'string' ? load.cloudaicompanionProject.trim() : '';
			if (projectFromLoad) {
				return { projectId: projectFromLoad };
			}
			if (load.currentTier) {
				// Existing paid/legacy users may not get project in payload; explicit config is enough.
				return preferredProject ? { projectId: preferredProject } : {};
			}

			const allowedTiers = Array.isArray(load.allowedTiers) ? load.allowedTiers : [];
			const selectedTier = allowedTiers.find(t => !!t?.isDefault) ?? allowedTiers[0];
			const tierId = typeof selectedTier?.id === 'string' && selectedTier.id.trim() ? selectedTier.id.trim() : 'legacy-tier';
			const onboardPayload: Record<string, unknown> = {
				tierId,
				metadata
			};
			if (tierId !== 'free-tier' && preferredProject) {
				onboardPayload['cloudaicompanionProject'] = preferredProject;
			}
			const onboardResponse = await fetch(`${GEMINI_CODE_ASSIST_BASE_URL}:onboardUser`, {
				method: 'POST',
				headers,
				body: JSON.stringify(onboardPayload)
			});
			const onboardRaw = await onboardResponse.text();
			if (!onboardResponse.ok) {
				const detail = this.readGeminiCodeAssistErrorDetailFromRaw(onboardRaw) ?? this.readGeminiErrorDetailFromRaw(onboardRaw);
				return { warning: detail ?? `onboardUser failed with HTTP ${onboardResponse.status}` };
			}

			let operation = JSON.parse(onboardRaw) as {
				done?: boolean;
				name?: string;
				response?: { cloudaicompanionProject?: { id?: string } };
			};

			let pollCount = 0;
			while (!operation.done && operation.name && pollCount < 12 && !token.isCancellationRequested) {
				pollCount++;
				await timeout(1500);
				const operationName = operation.name.replace(/^\/+/, '');
				const pollResponse = await fetch(`${GEMINI_CODE_ASSIST_BASE_URL}/${operationName}`, {
					method: 'GET',
					headers
				});
				const pollRaw = await pollResponse.text();
				if (!pollResponse.ok) {
					const detail = this.readGeminiCodeAssistErrorDetailFromRaw(pollRaw) ?? this.readGeminiErrorDetailFromRaw(pollRaw);
					return { warning: detail ?? `getOperation failed with HTTP ${pollResponse.status}` };
				}
				operation = JSON.parse(pollRaw) as typeof operation;
			}

			const onboardProject = operation.response?.cloudaicompanionProject?.id?.trim();
			if (onboardProject) {
				return { projectId: onboardProject };
			}
			if (preferredProject) {
				return { projectId: preferredProject };
			}
			if (!operation.done) {
				return { warning: 'Code Assist onboarding did not complete in time.' };
			}
			return {};
		} catch (error) {
			return { warning: toErrorMessage(error) };
		}
	}

	private buildGeminiCodeAssistMetadata(preferredProject: string | undefined): Record<string, unknown> {
		const metadata: Record<string, unknown> = {
			ideType: 'VSCODE',
			pluginType: 'GEMINI'
		};

		const platform = typeof process !== 'undefined' ? process.platform : '';
		const arch = typeof process !== 'undefined' ? process.arch : '';
		if (platform === 'linux' && arch === 'x64') {
			metadata['platform'] = 'LINUX_AMD64';
		} else if (platform === 'linux' && arch === 'arm64') {
			metadata['platform'] = 'LINUX_ARM64';
		} else if (platform === 'darwin' && arch === 'x64') {
			metadata['platform'] = 'DARWIN_AMD64';
		} else if (platform === 'darwin' && arch === 'arm64') {
			metadata['platform'] = 'DARWIN_ARM64';
		} else if (platform === 'win32' && arch === 'x64') {
			metadata['platform'] = 'WINDOWS_AMD64';
		} else {
			metadata['platform'] = 'PLATFORM_UNSPECIFIED';
		}

		if (preferredProject) {
			metadata['duetProject'] = preferredProject;
		}
		return metadata;
	}

	private readGeminiCodeAssistErrorDetailFromRaw(raw: string): string | undefined {
		const trimmed = raw.trim();
		if (!trimmed) {
			return undefined;
		}
		try {
			const payload = JSON.parse(trimmed) as { error?: { message?: string; details?: Array<{ reason?: string; domain?: string }> } };
			const base = typeof payload.error?.message === 'string' ? payload.error.message.trim() : '';
			const detail = payload.error?.details?.find(item => typeof item?.reason === 'string' && item.reason.trim());
			if (base && detail?.reason) {
				const domainPart = detail.domain ? ` (${detail.domain})` : '';
				return `${base} [${detail.reason}]${domainPart}`;
			}
			return base || undefined;
		} catch {
			return undefined;
		}
	}

	private extractGeminiCodeAssistText(raw: string): string {
		const trimmed = raw.trim();
		if (!trimmed) {
			return '';
		}
		try {
			const payload = JSON.parse(trimmed) as {
				response?: { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
			};
			const chunks = (payload.response?.candidates ?? [])
				.flatMap(candidate => candidate.content?.parts ?? [])
				.map(part => typeof part.text === 'string' ? part.text.trim() : '')
				.filter(Boolean);
			return chunks.join('\n').trim();
		} catch {
			return '';
		}
	}

	private readGeminiErrorDetailFromRaw(raw: string): string | undefined {
		const trimmed = raw.trim();
		if (!trimmed) {
			return undefined;
		}
		try {
			const payload = JSON.parse(trimmed) as { error?: { message?: string } };
			const message = payload.error?.message;
			return typeof message === 'string' && message.trim() ? message.trim() : undefined;
		} catch {
			return trimmed.slice(0, 300);
		}
	}

	private extractGeminiText(raw: string): string {
		const trimmed = raw.trim();
		if (!trimmed) {
			return '';
		}
		try {
			const payload = JSON.parse(trimmed) as {
				candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
			};
			const chunks = (payload.candidates ?? [])
				.flatMap(candidate => candidate.content?.parts ?? [])
				.map(part => typeof part.text === 'string' ? part.text.trim() : '')
				.filter(Boolean);
			return chunks.join('\n').trim();
		} catch {
			return '';
		}
	}

	private async doInvokeOpenAICodexOAuthSwarm(
		request: IChatAgentRequest,
		progress: (part: IChatProgress) => void,
		provider: INeocodeSwarmProviderConfig,
		config: INeocodeSwarmConfig,
		selectedModel: string,
		accessToken: string,
		history: IChatAgentHistoryEntry[]
	): Promise<IChatAgentResult> {
		const baseUrl = normalizeBaseUrl(provider.baseUrl ?? OPENAI_CODEX_BASE_URL);
		const endpoint = `${baseUrl}/responses`;
		const orchestrator = config.orchestrator;
		const inlineEditContext = await this.resolveInlineEditContext(request);
		this.notifyMissingInlineEditContextIfNeeded(request, inlineEditContext, progress);
		const effectiveUserMessage = this.resolveEffectiveUserMessage(request.message, history);
		const contextualUserMessage = await this.buildPromptWithAttachedCodeContext(request, effectiveUserMessage, inlineEditContext);
		let modelToUse = selectedModel;
		let includeInstructions = true;
		let includeMaxTokens = true;
		const removedUnsupportedParams = new Set<string>();
		progress({
			kind: 'progressMessage',
			content: new MarkdownString(localize('swarmOpenAICodexInvoking', "NeoCode Swarm: Orchestrating via OpenAI Codex OAuth ({0})...", modelToUse))
		});

		try {
			for (let attempt = 0; attempt < 4; attempt++) {
				const requestBody: Record<string, unknown> = {
					model: modelToUse,
					stream: true,
					store: false,
					input: [
						{
							role: 'user',
							content: [
								{
									type: 'input_text',
									text: inlineEditContext
										? this.buildInlineEditPrompt(contextualUserMessage, inlineEditContext.selectedText)
										: contextualUserMessage
								}
							]
						}
					]
				};
				const systemRule = orchestrator.systemRule?.trim();
				if (includeInstructions && systemRule) {
					requestBody.instructions = systemRule;
				}
				if (includeMaxTokens && typeof orchestrator.maxTokens === 'number') {
					requestBody.max_tokens = orchestrator.maxTokens;
				}

				const response = await this.performOpenAIHttpRequest({
					type: 'POST',
					url: endpoint,
					headers: {
						'Content-Type': 'application/json',
						'Authorization': `Bearer ${accessToken}`
					},
					data: JSON.stringify(requestBody)
				});
				const statusCode = response.statusCode;
				const raw = response.body;

				if (statusCode < 200 || statusCode >= 300) {
					const detail = this.readOpenAIErrorDetailFromRaw(raw);
					const unsupportedParam = this.getUnsupportedCodexParameter(detail);
					if (unsupportedParam && !removedUnsupportedParams.has(unsupportedParam)) {
						removedUnsupportedParams.add(unsupportedParam);
						if (unsupportedParam === 'max_tokens') {
							includeMaxTokens = false;
							this.logService.warn('[chat setup] OpenAI Codex OAuth rejected max_tokens, retrying without it');
							continue;
						}
						if (unsupportedParam === 'instructions') {
							includeInstructions = false;
							this.logService.warn('[chat setup] OpenAI Codex OAuth rejected instructions, retrying without it');
							continue;
						}
					}
					if (attempt === 0 && this.shouldFallbackCodexModel(statusCode, detail) && modelToUse.toLowerCase() !== 'gpt-5') {
						modelToUse = 'gpt-5';
						this.logService.warn('[chat setup] OpenAI Codex OAuth model fallback to gpt-5 due unsupported model:', detail);
						progress({
							kind: 'progressMessage',
							content: new MarkdownString(localize('swarmOpenAICodexModelFallback', "NeoCode Swarm: modelo '{0}' indisponivel no Codex OAuth, tentando 'gpt-5'...", selectedModel))
						});
						continue;
					}
					const message = detail
						? localize('swarmOpenAICodexInvocationErrorDetailed', "NeoCode Swarm: OpenAI Codex OAuth error (HTTP {0}): {1}", statusCode, detail)
						: localize('swarmOpenAICodexInvocationError', "NeoCode Swarm: OpenAI Codex OAuth error (HTTP {0}).", statusCode);
					progress({ kind: 'markdownContent', content: new MarkdownString(message) });
					return {};
				}
				const text = this.extractOpenAICodexText(raw);
				if (text) {
					if (inlineEditContext) {
						await this.handleInlineEditResponse(inlineEditContext, text, progress);
					} else {
						progress({ kind: 'markdownContent', content: new MarkdownString(text) });
					}
				} else {
					progress({ kind: 'markdownContent', content: new MarkdownString(localize('swarmOpenAICodexEmpty', "NeoCode Swarm: OpenAI Codex OAuth retornou resposta vazia.")) });
				}
				return {};
			}

			return {};
		} catch (error) {
			this.logService.error('[chat setup] OpenAI Codex OAuth swarm invocation failed:', error);
			progress({
				kind: 'markdownContent',
				content: new MarkdownString(localize('swarmOpenAICodexGenericFailure', "NeoCode Swarm: falha ao chamar OpenAI Codex OAuth: {0}", toErrorMessage(error)))
			});
			return {};
		}
	}

	private extractOpenAICodexText(raw: string): string {
		const trimmed = raw.trim();
		if (!trimmed) {
			return '';
		}

		try {
			const payload = JSON.parse(trimmed) as Record<string, unknown>;
			const directText = this.extractOpenAIResponsesText(payload);
			if (directText) {
				return directText;
			}
		} catch {
			// Not JSON; continue with SSE parsing.
		}

		let deltaText = '';
		let snapshotText = '';
		for (const line of trimmed.split(/\r?\n/)) {
			const chunk = line.trim();
			if (!chunk.startsWith('data:')) {
				continue;
			}
			const jsonChunk = chunk.slice(5).trim();
			if (!jsonChunk || jsonChunk === '[DONE]') {
				continue;
			}
			try {
				const event = JSON.parse(jsonChunk) as Record<string, unknown>;
				const eventType = typeof event.type === 'string' ? event.type : '';
				if (eventType.includes('response.output_text.delta') && typeof event.delta === 'string') {
					deltaText += event.delta;
					continue;
				}

				const responsePayload = event.response && typeof event.response === 'object'
					? event.response as Record<string, unknown>
					: event;
				const eventText = this.extractOpenAIResponsesText(responsePayload);
				if (eventText) {
					snapshotText = eventText;
				}
			} catch {
				// ignore malformed SSE chunk
			}
		}

		return deltaText.trim() || snapshotText.trim();
	}

	private extractOpenAIResponsesText(payload: Record<string, unknown>): string {
		const directOutputText = payload.output_text;
		if (typeof directOutputText === 'string' && directOutputText.trim()) {
			return directOutputText.trim();
		}

		const output = Array.isArray(payload.output) ? payload.output : [];
		const chunks: string[] = [];
		for (const item of output) {
			if (!item || typeof item !== 'object') {
				continue;
			}
			const content = Array.isArray((item as { content?: unknown }).content) ? (item as { content: unknown[] }).content : [];
			for (const block of content) {
				if (!block || typeof block !== 'object') {
					continue;
				}
				const text = (block as { text?: unknown }).text;
				if (typeof text === 'string' && text.trim()) {
					chunks.push(text.trim());
				}
			}
		}
		return chunks.join('\n').trim();
	}

	private shouldFallbackCodexModel(status: number, detail: string | undefined): boolean {
		if (status !== 400 && status !== 404) {
			return false;
		}
		const message = (detail ?? '').toLowerCase();
		if (!message) {
			return false;
		}
		return message.includes('not supported')
			|| message.includes('unsupported model')
			|| message.includes('model is not supported')
			|| message.includes('does not exist');
	}

	private notifyMissingInlineEditContextIfNeeded(request: IChatAgentRequest, context: IInlineEditContext | undefined, progress: (part: IChatProgress) => void): void {
		if (context || !this.isInlineEditIntent(request.message)) {
			return;
		}
		progress({
			kind: 'progressMessage',
			content: new MarkdownString(localize(
				'swarmInlineEditMissingContext',
				"NeoCode Swarm: nao encontrei contexto de linha/selecao. Use Ctrl+L na linha ou selecao antes de enviar."
			))
		});
	}

	private resolveEffectiveUserMessage(message: string, history: IChatAgentHistoryEntry[]): string {
		const normalizedMessage = message.trim();
		if (!this.isGenericApplyCommand(normalizedMessage)) {
			return normalizedMessage;
		}

		for (let i = history.length - 1; i >= 0; i--) {
			const candidate = history[i]?.request?.message?.trim();
			if (!candidate || this.isGenericApplyCommand(candidate)) {
				continue;
			}
			return `${candidate}\n\nInstrucao final do usuario: ${normalizedMessage}.`;
		}

		return normalizedMessage;
	}

	private isGenericApplyCommand(message: string): boolean {
		const value = message.trim().toLowerCase();
		if (!value) {
			return false;
		}
		return /^(aplique|aplicar|apply|fa[çc]a|fa[çc]a isso|pode aplicar|execute|executar|run|comece|start)$/i.test(value);
	}

	private async buildPromptWithAttachedCodeContext(request: IChatAgentRequest, baseMessage: string, inlineEditContext: IInlineEditContext | undefined): Promise<string> {
		const contexts = await this.collectAttachedCodeContexts(request, inlineEditContext);
		if (!contexts.length) {
			return baseMessage;
		}

		const renderedContexts = contexts.map((context, index) => {
			const header = `[${index + 1}] ${context.uri.toString()}${this.formatRangeLabel(context.range)} (${context.source})`;
			return `${header}\n<trecho>\n${context.text}\n</trecho>`;
		}).join('\n\n');

		return [
			baseMessage,
			'',
			'Contexto de codigo anexado automaticamente (ferramentas do agente):',
			renderedContexts,
			'',
			'Use esses trechos como fonte principal e preserve o escopo de linha/range anexado.'
		].join('\n');
	}

	private async collectAttachedCodeContexts(request: IChatAgentRequest, inlineEditContext: IInlineEditContext | undefined): Promise<IAttachedCodeContext[]> {
		const contexts: IAttachedCodeContext[] = [];
		const seen = new Set<string>();
		const maxContexts = 6;

		const pushContext = async (uri: URI, range: IRange | undefined, source: string): Promise<void> => {
			if (contexts.length >= maxContexts) {
				return;
			}
			const key = `${uri.toString()}#${range ? `${range.startLineNumber}:${range.startColumn}-${range.endLineNumber}:${range.endColumn}` : 'full'}`;
			if (seen.has(key)) {
				return;
			}
			const text = await this.readSnippetFromUri(uri, range);
			if (!text?.trim()) {
				return;
			}
			seen.add(key);
			contexts.push({ uri, range, text, source });
		};

		if (inlineEditContext?.selectedText?.trim()) {
			const lifted = Selection.liftSelection(inlineEditContext.selection);
			contexts.push({
				uri: inlineEditContext.document,
				range: lifted,
				text: this.clipText(inlineEditContext.selectedText, 5000),
				source: 'selecao ativa'
			});
			seen.add(`${inlineEditContext.document.toString()}#${lifted.startLineNumber}:${lifted.startColumn}-${lifted.endLineNumber}:${lifted.endColumn}`);
		}

		for (const variable of request.variables.variables) {
			if (contexts.length >= maxContexts) {
				break;
			}
			if (isLocation(variable.value)) {
				await pushContext(variable.value.uri, variable.value.range, `anexo:${variable.kind}`);
			} else if (URI.isUri(variable.value) && variable.kind === 'file') {
				await pushContext(variable.value, undefined, `anexo:${variable.kind}`);
			}

			if (variable.kind === 'paste' && variable.code?.trim()) {
				const copiedFromRange = variable.copiedFrom?.range;
				const copiedFromUri = variable.copiedFrom?.uri ?? request.sessionResource;
				const key = `${copiedFromUri.toString()}#paste:${variable.id}`;
				if (!seen.has(key) && contexts.length < maxContexts) {
					seen.add(key);
					contexts.push({
						uri: copiedFromUri,
						range: copiedFromRange,
						text: this.clipText(variable.code, 5000),
						source: 'anexo:paste'
					});
				}
			}

			for (const reference of variable.references ?? []) {
				if (!isLocation(reference.reference)) {
					continue;
				}
				await pushContext(reference.reference.uri, reference.reference.range, 'referencia');
			}
		}

		for (const mention of this.parseMessageLineMentions(request.message)) {
			if (contexts.length >= maxContexts) {
				break;
			}
			const uri = await this.resolveMentionUri(mention.path);
			if (!uri) {
				continue;
			}
			const range = typeof mention.startLine === 'number'
				? {
					startLineNumber: mention.startLine,
					startColumn: 1,
					endLineNumber: typeof mention.endLine === 'number' ? Math.max(mention.startLine, mention.endLine) : mention.startLine,
					endColumn: Number.MAX_SAFE_INTEGER
				}
				: undefined;
			await pushContext(uri, range, 'mencao');
		}

		return contexts;
	}

	private async readSnippetFromUri(uri: URI, range: IRange | undefined): Promise<string | undefined> {
		try {
			const content = (await this.fileService.readFile(uri)).value.toString();
			if (range) {
				const offsets = this.selectionToOffsets(content, this.rangeToSelection(range));
				if (!offsets) {
					return undefined;
				}
				let selected = content.slice(offsets.start, offsets.end);
				if (!selected) {
					selected = this.readLineText(content, range.startLineNumber) ?? '';
				}
				return this.clipText(selected, 5000);
			}

			const firstLines = content.split(/\r?\n/).slice(0, 120).join('\n');
			return this.clipText(firstLines, 5000);
		} catch {
			return undefined;
		}
	}

	private clipText(value: string, maxChars: number): string {
		if (value.length <= maxChars) {
			return value;
		}
		return `${value.slice(0, maxChars)}\n...[trecho truncado]...`;
	}

	private formatRangeLabel(range: IRange | undefined): string {
		if (!range) {
			return '';
		}
		return range.startLineNumber === range.endLineNumber
			? `#L${range.startLineNumber}`
			: `#L${range.startLineNumber}-${range.endLineNumber}`;
	}

	private async collectReferencedFilePaths(request: IChatAgentRequest, inlineEditContext: IInlineEditContext | undefined): Promise<string[]> {
		const result: string[] = [];
		const seen = new Set<string>();

		const addUri = (uri: URI | undefined): void => {
			if (!uri) {
				return;
			}
			const value = uri.scheme === 'file' ? uri.fsPath : uri.path;
			if (!value || seen.has(value)) {
				return;
			}
			seen.add(value);
			result.push(value);
		};

		addUri(inlineEditContext?.document);

		for (const variable of request.variables.variables) {
			if (isLocation(variable.value)) {
				addUri(variable.value.uri);
			} else if (URI.isUri(variable.value)) {
				addUri(variable.value);
			}
			if (variable.kind === 'paste') {
				addUri(variable.copiedFrom?.uri);
			}
			for (const reference of variable.references ?? []) {
				if (isLocation(reference.reference)) {
					addUri(reference.reference.uri);
				}
			}
		}

		for (const mention of this.parseMessageLineMentions(request.message)) {
			const uri = await this.resolveMentionUri(mention.path);
			addUri(uri);
		}

		return result.slice(0, 24);
	}

	private getUnsupportedCodexParameter(detail: string | undefined): string | undefined {
		const message = detail?.trim();
		if (!message) {
			return undefined;
		}
		const match = /unsupported parameter:\s*([a-zA-Z0-9_.-]+)/i.exec(message);
		return match?.[1];
	}

	private resolveAnthropicCliPath(): string {
		return 'claude';
	}

	private resolveAnthropicCliCandidates(): string[] {
		const preferred = this.resolveAnthropicCliPath();
		const candidates = [preferred, 'claude'];
		const unique: string[] = [];
		for (const candidate of candidates) {
			const normalized = candidate.trim();
			if (!normalized || unique.includes(normalized)) {
				continue;
			}
			unique.push(normalized);
		}
		return unique;
	}

	private isAnthropicCliMismatch(detail: string): boolean {
		const text = detail.toLowerCase();
		return (
			text.includes('gcloud.auth') ||
			text.includes("invalid choice: 'status'") ||
			text.includes('to search the help text of gcloud commands')
		);
	}

	private async getAnthropicCliAuthStatus(cliCandidates: readonly string[]): Promise<{ ok: true; message: string; cliPath: string } | { ok: false; message: string }> {
		const errors: string[] = [];

		for (const cliPath of cliCandidates) {
			const result = await this.runSwarmCliExec(cliPath, ['auth', 'status', '--json'], 30_000);
			if (result.exitCode !== 0) {
				const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
				if (detail) {
					errors.push(`${cliPath}: ${detail}`);
				}
				// Try next candidate if this command looks like a different CLI (e.g. gcloud).
				if (detail && this.isAnthropicCliMismatch(detail)) {
					continue;
				}
				continue;
			}

			try {
				const parsed = JSON.parse(result.stdout) as { loggedIn?: boolean; email?: string; orgName?: string };
				if (parsed.loggedIn) {
					const identity = parsed.email?.trim() || parsed.orgName?.trim() || 'Claude CLI autenticado';
					return {
						ok: true,
						cliPath,
						message: localize('swarmAnthropicCliAuthConnected', "NeoCode Swarm: sessao Claude ativa ({0}).", identity)
					};
				}
				return {
					ok: false,
					message: localize('swarmAnthropicCliAuthMissing', "NeoCode Swarm: sessao Claude ausente. Use 'Iniciar Login Nativo' no provedor Anthropic.")
				};
			} catch {
				errors.push(`${cliPath}: invalid json`);
			}
		}

		const detail = errors.join(' | ');
		return {
			ok: false,
			message: detail
				? localize('swarmAnthropicCliAuthStatusFailedDetail', "NeoCode Swarm: falha ao verificar sessao Claude CLI: {0}", detail)
				: localize('swarmAnthropicCliAuthStatusFailed', "NeoCode Swarm: falha ao verificar sessao Claude CLI.")
		};
	}

	private async invokeAnthropicViaCli(
		cliPath: string,
		model: string,
		systemRule: string | undefined,
		userMessage: string,
		inlineEditContext: IInlineEditContext | undefined,
		progress: (part: IChatProgress) => void
	): Promise<IChatAgentResult> {
		const prompt = systemRule
			? `System:\n${systemRule}\n\nUser:\n${userMessage}`
			: userMessage;

		progress({
			kind: 'progressMessage',
			content: new MarkdownString(localize('swarmAnthropicCliInvoking', "NeoCode Swarm: Orchestrating via Claude CLI ({0})...", model))
		});

		// Only pass --model if the model ID looks like a real Anthropic model (e.g. claude-*).
		// Internal model IDs like 'cloud-code-default' cause the CLI to reject the request.
		const cliArgs = ['-p', '--output-format', 'json', '--tools', ''];
		if (model && /^claude-/i.test(model)) {
			cliArgs.splice(1, 0, '--model', model);
		}

		const result = await this.runSwarmCliExec(
			cliPath,
			cliArgs,
			180_000,
			prompt
		);

		if (result.exitCode !== 0) {
			const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
			progress({
				kind: 'markdownContent',
				content: new MarkdownString(
					detail
						? localize('swarmAnthropicCliInvokeFailedDetail', "NeoCode Swarm: falha no Claude CLI: {0}", detail)
						: localize('swarmAnthropicCliInvokeFailed', "NeoCode Swarm: falha ao executar Claude CLI.")
				)
			});
			return {};
		}

		const text = this.extractClaudeCliResult(result.stdout);
		if (!text) {
			progress({
				kind: 'markdownContent',
				content: new MarkdownString(localize('swarmAnthropicCliEmpty', "NeoCode Swarm: Claude CLI retornou resposta vazia."))
			});
			return {};
		}

		if (inlineEditContext) {
			await this.handleInlineEditResponse(inlineEditContext, text, progress);
		} else {
			progress({ kind: 'markdownContent', content: new MarkdownString(text) });
		}
		return {};
	}

	private extractClaudeCliResult(raw: string): string {
		const trimmed = raw.trim();
		if (!trimmed) {
			return '';
		}
		try {
			const parsed = JSON.parse(trimmed) as { result?: string };
			if (typeof parsed.result === 'string' && parsed.result.trim()) {
				return parsed.result.trim();
			}
			return trimmed;
		} catch {
			return trimmed;
		}
	}

	private async invokeAnthropicViaHttp(
		apiKey: string,
		model: string,
		systemRule: string | undefined,
		userMessage: string,
		provider: INeocodeSwarmProviderConfig,
		maxTokens: number | undefined,
		inlineEditContext: IInlineEditContext | undefined,
		progress: (part: IChatProgress) => void
	): Promise<IChatAgentResult> {
		const baseUrl = normalizeBaseUrl(provider.baseUrl ?? 'https://api.anthropic.com');
		const endpoint = `${baseUrl}/v1/messages`;
		progress({
			kind: 'progressMessage',
			content: new MarkdownString(localize('swarmAnthropicHttpInvoking', "NeoCode Swarm: Orchestrating via Anthropic HTTP ({0})...", model))
		});

		try {
			const requestBody: Record<string, unknown> = {
				model,
				max_tokens: typeof maxTokens === 'number' ? Math.max(1, Math.floor(maxTokens)) : 4096,
				messages: [{ role: 'user', content: userMessage }]
			};
			if (systemRule) {
				requestBody.system = systemRule;
			}

			const response = await this.performOpenAIHttpRequest({
				type: 'POST',
				url: endpoint,
				headers: {
					'Content-Type': 'application/json',
					'x-api-key': apiKey,
					'anthropic-version': '2023-06-01'
				},
				data: JSON.stringify(requestBody)
			});

			if (response.statusCode < 200 || response.statusCode >= 300) {
				const detail = this.readAnthropicErrorDetailFromRaw(response.body);
				progress({
					kind: 'markdownContent',
					content: new MarkdownString(detail
						? localize('swarmAnthropicHttpErrorDetail', "NeoCode Swarm: Anthropic error (HTTP {0}): {1}", response.statusCode, detail)
						: localize('swarmAnthropicHttpError', "NeoCode Swarm: Anthropic error (HTTP {0}).", response.statusCode))
				});
				return {};
			}

			const text = this.extractAnthropicText(response.body);
			if (!text) {
				progress({
					kind: 'markdownContent',
					content: new MarkdownString(localize('swarmAnthropicHttpEmpty', "NeoCode Swarm: Anthropic retornou resposta vazia."))
				});
				return {};
			}

			if (inlineEditContext) {
				await this.handleInlineEditResponse(inlineEditContext, text, progress);
			} else {
				progress({ kind: 'markdownContent', content: new MarkdownString(text) });
			}
			return {};
		} catch (error) {
			progress({
				kind: 'markdownContent',
				content: new MarkdownString(localize('swarmAnthropicHttpFailure', "NeoCode Swarm: falha ao chamar Anthropic: {0}", toErrorMessage(error)))
			});
			return {};
		}
	}

	private extractAnthropicText(raw: string): string {
		const trimmed = raw.trim();
		if (!trimmed) {
			return '';
		}
		try {
			const payload = JSON.parse(trimmed) as {
				content?: Array<{ type?: string; text?: string }>;
			};
			return (payload.content ?? [])
				.filter(part => part?.type === 'text' && typeof part.text === 'string')
				.map(part => part.text!.trim())
				.filter(Boolean)
				.join('\n')
				.trim();
		} catch {
			return '';
		}
	}

	private readAnthropicErrorDetailFromRaw(raw: string): string | undefined {
		const trimmed = raw.trim();
		if (!trimmed) {
			return undefined;
		}
		try {
			const payload = JSON.parse(trimmed) as {
				error?: { message?: string; type?: string };
			};
			if (payload.error?.message) {
				return payload.error.type
					? `${payload.error.message} (${payload.error.type})`
					: payload.error.message;
			}
			return trimmed.slice(0, 300);
		} catch {
			return trimmed.slice(0, 300);
		}
	}

	private async runSwarmCliExec(command: string, args: string[], timeoutMs: number, stdin?: string): Promise<INeocodeSwarmCliExecResult> {
		let utilityProcessService: IUtilityProcessWorkerServiceLike;
		try {
			const module = await import('../../../../services/utilityProcess/electron-browser/utilityProcessWorkerWorkbenchService.js');
			utilityProcessService = this.instantiationService.invokeFunction(accessor => accessor.get(module.IUtilityProcessWorkerWorkbenchService)) as IUtilityProcessWorkerServiceLike;
		} catch (error) {
			return {
				exitCode: 1,
				stdout: '',
				stderr: error instanceof Error ? error.message : String(error),
				timedOut: false
			};
		}

		let worker: IUtilityProcessWorkerHandle | undefined;
		try {
			worker = await utilityProcessService.createWorker({
				moduleId: SWARM_CLI_EXEC_WORKER_MODULE_ID,
				type: 'swarmCliExec',
				name: 'NeoCode Swarm CLI Exec'
			});
			const service = ProxyChannel.toService<INeocodeSwarmCliExecService>(worker.client.getChannel(NEO_SWARM_CLI_EXEC_CHANNEL));
			return await service.exec({
				command,
				args,
				timeoutMs,
				stdin
			} satisfies INeocodeSwarmCliExecOptions);
		} catch (error) {
			return {
				exitCode: 1,
				stdout: '',
				stderr: error instanceof Error ? error.message : String(error),
				timedOut: false
			};
		} finally {
			worker?.dispose();
		}
	}

	private async performOpenAIHttpRequest(request: {
		type: 'GET' | 'POST';
		url: string;
		headers?: Record<string, string>;
		data?: string;
	}): Promise<IOpenAIHttpResponse> {
		let utilityProcessService: IUtilityProcessWorkerServiceLike;
		try {
			const module = await import('../../../../services/utilityProcess/electron-browser/utilityProcessWorkerWorkbenchService.js');
			utilityProcessService = this.instantiationService.invokeFunction(accessor => accessor.get(module.IUtilityProcessWorkerWorkbenchService)) as IUtilityProcessWorkerServiceLike;
		} catch (error) {
			throw new Error(localize(
				'neoSwarm.openaiWorkerUnavailable',
				"Nao foi possivel iniciar o worker de rede OpenAI: {0}",
				error instanceof Error ? error.message : String(error)
			));
		}

		let worker: IUtilityProcessWorkerHandle | undefined;
		try {
			worker = await utilityProcessService.createWorker({
				moduleId: OPENAI_HTTP_WORKER_MODULE_ID,
				type: 'openaiHttpRequest',
				name: 'NeoCode OpenAI HTTP Bridge'
			});
			const requestService = ProxyChannel.toService<IOpenAIRequestService>(worker.client.getChannel(NEO_SWARM_OPENAI_REQUEST_CHANNEL));
			const response = await requestService.request({
				method: request.type,
				url: request.url,
				headers: request.headers,
				body: request.data,
				timeoutMs: 45000
			} satisfies IOpenAIHttpRequestOptions);
			return response;
		} finally {
			worker?.dispose();
		}
	}

	private async resolveInlineEditContext(request: IChatAgentRequest): Promise<IInlineEditContext | undefined> {
		if (!this.isInlineEditIntent(request.message)) {
			return undefined;
		}

		let document: URI | undefined;
		let selection: ISelection | undefined;

		if (request.locationData?.type === ChatAgentLocation.EditorInline) {
			document = request.locationData.document;
			selection = request.locationData.selection;
		}

		if (!document || !selection) {
			const variableLocation = this.resolveInlineEditLocationFromVariables(request.variables.variables);
			document = variableLocation?.document;
			selection = variableLocation?.selection;
		}

		if (!document || !selection) {
			const mentionedLocation = await this.resolveInlineEditLocationFromMessageMentions(request.message);
			document = mentionedLocation?.document;
			selection = mentionedLocation?.selection;
		}

		if (!document || !selection) {
			this.logService.trace('[chat setup] inline edit requested but no location context was found', {
				location: request.location,
				variableCount: request.variables.variables.length
			});
			return undefined;
		}

		try {
			const content = (await this.fileService.readFile(document)).value.toString();
			const offsets = this.selectionToOffsets(content, selection);
			if (!offsets) {
				return undefined;
			}
			const normalizedSelection = Selection.liftSelection(selection);
			let selectedText = content.slice(offsets.start, offsets.end);
			if (!selectedText) {
				selectedText = this.readLineText(content, normalizedSelection.startLineNumber) ?? '';
			}
			this.logService.trace('[chat setup] inline edit context resolved', {
				resource: document.toString(),
				line: normalizedSelection.startLineNumber
			});
			return { document, selection, selectedText };
		} catch {
			return undefined;
		}
	}

	private resolveInlineEditLocationFromVariables(variables: readonly IChatRequestVariableEntry[]): { document: URI; selection: ISelection } | undefined {
		let fallback: { document: URI; selection: ISelection } | undefined;

		for (const variable of variables) {
			const directLocation = this.resolveInlineEditLocationFromValue(variable.value);
			if (directLocation) {
				// Prefer the explicit current-selection attachment (Ctrl+L style implicit selection),
				// but still support regular file/location attachments with ranges.
				if (isImplicitVariableEntry(variable) && variable.isSelection) {
					return directLocation;
				}
				fallback ??= directLocation;
			}

			if (variable.kind === 'paste' && variable.copiedFrom) {
				return {
					document: variable.copiedFrom.uri,
					selection: this.rangeToSelection(variable.copiedFrom.range)
				};
			}

			const refLocation = this.resolveInlineEditLocationFromReferences(variable.references);
			if (refLocation) {
				fallback ??= refLocation;
			}
		}

		return fallback;
	}

	private resolveInlineEditLocationFromValue(value: unknown): { document: URI; selection: ISelection } | undefined {
		if (!value || !isLocation(value)) {
			return undefined;
		}
		return {
			document: value.uri,
			selection: this.rangeToSelection(value.range)
		};
	}

	private resolveInlineEditLocationFromReferences(references: IChatRequestVariableEntry['references']): { document: URI; selection: ISelection } | undefined {
		if (!references?.length) {
			return undefined;
		}
		for (const reference of references) {
			if (!isLocation(reference.reference)) {
				continue;
			}
			return {
				document: reference.reference.uri,
				selection: this.rangeToSelection(reference.reference.range)
			};
		}
		return undefined;
	}

	private async resolveInlineEditLocationFromMessageMentions(message: string): Promise<{ document: URI; selection: ISelection } | undefined> {
		const mentions = this.parseMessageLineMentions(message).filter(mention => typeof mention.startLine === 'number');
		for (const mention of mentions) {
			const uri = await this.resolveMentionUri(mention.path);
			if (!uri || typeof mention.startLine !== 'number') {
				continue;
			}
			const endLine = typeof mention.endLine === 'number' ? mention.endLine : mention.startLine;
			return {
				document: uri,
				selection: this.rangeToSelection({
					startLineNumber: mention.startLine,
					startColumn: 1,
					endLineNumber: Math.max(mention.startLine, endLine),
					endColumn: Number.MAX_SAFE_INTEGER
				})
			};
		}
		return undefined;
	}

	private parseMessageLineMentions(message: string): Array<{ path: string; startLine?: number; endLine?: number }> {
		const mentions: Array<{ path: string; startLine?: number; endLine?: number }> = [];
		const mentionPattern = /([^\s"'`<>]+?\.[a-zA-Z0-9_]+)(?:#L(\d+)(?:-L?(\d+))?|:(\d+)(?:-(\d+))?)?/g;
		for (const match of message.matchAll(mentionPattern)) {
			const rawPath = (match[1] ?? '').trim().replace(/[),.;:!?]+$/, '');
			if (!rawPath || /^https?:\/\//i.test(rawPath)) {
				continue;
			}
			const startLine = Number(match[2] ?? match[4]);
			const endLine = Number(match[3] ?? match[5]);
			mentions.push({
				path: rawPath,
				startLine: Number.isFinite(startLine) ? startLine : undefined,
				endLine: Number.isFinite(endLine) ? endLine : undefined
			});
		}
		return mentions;
	}

	private async resolveMentionUri(mentionPath: string): Promise<URI | undefined> {
		const normalizedPath = mentionPath.replace(/^['"`]+|['"`]+$/g, '');
		if (!normalizedPath) {
			return undefined;
		}

		const candidates: URI[] = [];
		if (normalizedPath.startsWith('/')) {
			candidates.push(URI.file(normalizedPath));
		}

		for (const folder of this.workspaceContextService.getWorkspace().folders) {
			candidates.push(joinPath(folder.uri, normalizedPath));
		}

		for (const candidate of candidates) {
			try {
				if (await this.fileService.exists(candidate)) {
					return candidate;
				}
			} catch {
				// ignore candidate resolution errors
			}
		}

		return undefined;
	}

	private rangeToSelection(range: IRange): ISelection {
		return new Selection(
			range.startLineNumber,
			range.startColumn,
			range.endLineNumber,
			range.endColumn
		);
	}

	private buildInlineEditPrompt(userMessage: string, selectedText: string): string {
		return [
			'Voce esta editando um trecho selecionado no arquivo local.',
			'Retorne SOMENTE o texto final que deve substituir o trecho selecionado.',
			'Nao use markdown, nao explique, nao adicione crases.',
			`Pedido do usuario: ${userMessage}`,
			'Trecho selecionado:',
			selectedText
		].join('\n');
	}

	private async handleInlineEditResponse(context: IInlineEditContext, rawModelResponse: string, progress: (part: IChatProgress) => void): Promise<void> {
		const replacement = this.extractInlineReplacement(rawModelResponse);
		if (!replacement) {
			progress({
				kind: 'markdownContent',
				content: new MarkdownString(rawModelResponse.trim() || localize('swarmInlineEditEmptyModelOutput', 'NeoCode Swarm: o modelo nao retornou texto para aplicar a edicao.'))
			});
			return;
		}

		const applied = await this.applyInlineEdit(context, replacement);
		if (!applied) {
			progress({ kind: 'markdownContent', content: new MarkdownString(rawModelResponse) });
			return;
		}

		progress({
			kind: 'progressMessage',
			content: new MarkdownString(localize(
				'swarmInlineEditApplied',
				"NeoCode Swarm: edicao aplicada em {0}:{1}.",
				context.document.path.split('/').pop() ?? context.document.path,
				String(Selection.liftSelection(context.selection).startLineNumber)
			))
		});
		progress({ kind: 'markdownContent', content: new MarkdownString(replacement) });
	}

	private extractInlineReplacement(rawModelResponse: string): string {
		const raw = rawModelResponse.trim();
		if (!raw) {
			return '';
		}

		try {
			const parsed = JSON.parse(raw) as { replacement?: unknown; text?: unknown; value?: unknown; corrected?: unknown };
			const candidate = parsed.replacement ?? parsed.text ?? parsed.value ?? parsed.corrected;
			if (typeof candidate === 'string' && candidate.trim()) {
				return candidate;
			}
		} catch {
			// not json
		}

		const fencedMatch = raw.match(/```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)\n```/);
		if (fencedMatch?.[1]?.trim()) {
			return fencedMatch[1];
		}

		const quotedMatch = raw.match(/^["'`]{1}([\s\S]*?)["'`]{1}$/);
		if (quotedMatch?.[1]) {
			return quotedMatch[1];
		}

		return raw;
	}

	private async applyInlineEdit(context: IInlineEditContext, replacement: string): Promise<boolean> {
		try {
			const content = (await this.fileService.readFile(context.document)).value.toString();
			const offsets = this.selectionToOffsets(content, context.selection);
			if (!offsets) {
				return false;
			}
			const nextContent = `${content.slice(0, offsets.start)}${replacement}${content.slice(offsets.end)}`;
			if (nextContent === content) {
				return true;
			}
			await this.fileService.writeFile(context.document, VSBuffer.fromString(nextContent));
			return true;
		} catch {
			return false;
		}
	}

	private isInlineEditIntent(message: string): boolean {
		const value = message.toLowerCase();
		return /(corrij|corrija|edite|editar|altere|ajuste|fix|replace|substitua|nessa linha|nesta linha|essa linha|aplique|aplicar|fa[çc]a|mude|mudar|troque|trocar|atualize|errad|erro|deveria|deve ser)/i.test(value);
	}

	private selectionToOffsets(content: string, selection: ISelection): { start: number; end: number } | undefined {
		const normalized = Selection.liftSelection(selection);
		const start = this.positionToOffset(content, normalized.startLineNumber, normalized.startColumn);
		const end = this.positionToOffset(content, normalized.endLineNumber, normalized.endColumn);
		if (typeof start !== 'number' || typeof end !== 'number') {
			return undefined;
		}
		return start <= end ? { start, end } : { start: end, end: start };
	}

	private positionToOffset(content: string, lineNumber: number, column: number): number | undefined {
		if (lineNumber < 1 || column < 1) {
			return undefined;
		}
		const lineStarts: number[] = [0];
		for (let i = 0; i < content.length; i++) {
			if (content.charCodeAt(i) === 10 /* \n */) {
				lineStarts.push(i + 1);
			}
		}
		const lineIndex = Math.min(Math.max(lineNumber - 1, 0), lineStarts.length - 1);
		const lineStart = lineStarts[lineIndex];
		const lineEndExclusive = lineIndex + 1 < lineStarts.length ? lineStarts[lineIndex + 1] : content.length;
		const maxColumn = Math.max(1, (lineEndExclusive - lineStart) + 1);
		const boundedColumn = Math.min(Math.max(column, 1), maxColumn);
		return lineStart + boundedColumn - 1;
	}

	private readLineText(content: string, lineNumber: number): string | undefined {
		const lines = content.split(/\r?\n/);
		if (lineNumber < 1 || lineNumber > lines.length) {
			return undefined;
		}
		return lines[lineNumber - 1];
	}

	private readOpenAIErrorDetailFromRaw(rawResponse: string): string | undefined {
		try {
			const raw = rawResponse.trim();
			if (!raw) {
				return undefined;
			}
			const data = JSON.parse(raw) as { error?: { message?: string; type?: string; code?: string } };
			if (data.error) {
				const parts = [data.error.message, data.error.type, data.error.code].filter(Boolean);
				if (parts.length) {
					return parts.join(' | ');
				}
			}
			return raw.slice(0, 500);
		} catch {
			return undefined;
		}
	}

	private async resolveOpenAICredential(provider: INeocodeSwarmProviderConfig): Promise<{ ok: true; accessToken: string } | { ok: false; message: string }> {
		const kind = provider.authMethod === 'apiKey' ? 'apiKey' : 'loginToken';
		const secretScope = this.providerSecretScope(provider);
		const rawSecret = await this.getProviderSecretWithFallback(provider, kind);
		if (!rawSecret?.trim()) {
			return {
				ok: false,
				message: localize('swarmOpenAIMissingCredential', "NeoCode Swarm: credencial OpenAI ausente. Abra Configurar Enxame e conecte sua conta.")
			};
		}

		if (kind === 'apiKey') {
			return { ok: true, accessToken: rawSecret.trim() };
		}

		const parsed = parseStoredOpenAITokenBundle(rawSecret);
		if (!parsed?.accessToken?.trim()) {
			return {
				ok: false,
				message: localize('swarmOpenAIInvalidCredential', "NeoCode Swarm: token OAuth OpenAI invalido. Reconecte sua conta ChatGPT.")
			};
		}

		const resolved = await this.refreshOpenAITokenIfNeeded(secretScope, parsed);
		if (!resolved.ok) {
			return resolved;
		}

		return { ok: true, accessToken: resolved.token.accessToken };
	}

	private async refreshOpenAITokenIfNeeded(secretScope: string, token: IOpenAITokenBundle): Promise<{ ok: true; token: IOpenAITokenBundle } | { ok: false; message: string }> {
		if (!isOpenAITokenExpiredOrNearExpiry(token)) {
			return { ok: true, token };
		}
		if (!token.refreshToken?.trim()) {
			return {
				ok: false,
				message: localize('swarmOpenAIExpiredNoRefresh', "NeoCode Swarm: token OAuth expirado e sem refresh_token. Reconecte sua conta ChatGPT.")
			};
		}
		try {
			const refreshed = await refreshOpenAITokenBundle(token);
			await this.secretService.setProviderSecret(secretScope, 'loginToken', JSON.stringify(refreshed));
			return { ok: true, token: refreshed };
		} catch (error) {
			return {
				ok: false,
				message: localize('swarmOpenAIRefreshFailed', "NeoCode Swarm: falha ao atualizar token OpenAI automaticamente: {0}", toErrorMessage(error))
			};
		}
	}

	private providerSecretScope(provider: INeocodeSwarmProviderConfig): string {
		return provider.type === 'custom' ? provider.id : provider.type;
	}

	private async getProviderSecretWithFallback(provider: INeocodeSwarmProviderConfig, kind: 'apiKey' | 'loginToken' | 'cliToken'): Promise<string | undefined> {
		const scope = this.providerSecretScope(provider);
		let secret = await this.secretService.getProviderSecret(scope, kind);
		if (secret?.trim() || scope === provider.id) {
			return secret;
		}

		secret = await this.secretService.getProviderSecret(provider.id, kind);
		if (secret?.trim()) {
			await this.secretService.setProviderSecret(scope, kind, secret);
			await this.secretService.setProviderSecret(provider.id, kind, '');
		}
		return secret;
	}

	private async doInvokeWithoutSetup(request: IChatAgentRequest, progress: (part: IChatProgress) => void, chatService: IChatService, languageModelsService: ILanguageModelsService, chatWidgetService: IChatWidgetService, chatAgentService: IChatAgentService, languageModelToolsService: ILanguageModelToolsService): Promise<IChatAgentResult> {
		const requestModel = chatWidgetService.getWidgetBySessionResource(request.sessionResource)?.viewModel?.model.getRequests().at(-1);
		if (!requestModel) {
			this.logService.error('[chat setup] Request model not found, cannot redispatch request.');
			return {}; // this should not happen
		}

		progress({
			kind: 'progressMessage',
			content: new MarkdownString(localize('waitingChat', "Getting chat ready")),
			shimmer: true,
		});

		await this.forwardRequestToChat(requestModel, progress, chatService, languageModelsService, chatAgentService, chatWidgetService, languageModelToolsService);

		return {};
	}

	private async forwardRequestToChat(requestModel: IChatRequestModel, progress: (part: IChatProgress) => void, chatService: IChatService, languageModelsService: ILanguageModelsService, chatAgentService: IChatAgentService, chatWidgetService: IChatWidgetService, languageModelToolsService: ILanguageModelToolsService): Promise<void> {
		try {
			await this.doForwardRequestToChat(requestModel, progress, chatService, languageModelsService, chatAgentService, chatWidgetService, languageModelToolsService);
		} catch (error) {
			this.logService.error('[chat setup] Failed to forward request to chat', error);

			progress({
				kind: 'warning',
				content: new MarkdownString(localize('neoAgentsUnavailableWarning', "Failed to get a response. Please try again."))
			});
		}
	}

	private async doForwardRequestToChat(requestModel: IChatRequestModel, progress: (part: IChatProgress) => void, chatService: IChatService, languageModelsService: ILanguageModelsService, chatAgentService: IChatAgentService, chatWidgetService: IChatWidgetService, languageModelToolsService: ILanguageModelToolsService): Promise<void> {
		if (this.pendingForwardedRequests.has(requestModel.session.sessionResource)) {
			throw new Error('Request already in progress');
		}

		const forwardRequest = this.doForwardRequestToChatWhenReady(requestModel, progress, chatService, languageModelsService, chatAgentService, chatWidgetService, languageModelToolsService);
		this.pendingForwardedRequests.set(requestModel.session.sessionResource, forwardRequest);

		try {
			await forwardRequest;
		} finally {
			this.pendingForwardedRequests.delete(requestModel.session.sessionResource);
		}
	}

	private async doForwardRequestToChatWhenReady(requestModel: IChatRequestModel, progress: (part: IChatProgress) => void, chatService: IChatService, languageModelsService: ILanguageModelsService, chatAgentService: IChatAgentService, chatWidgetService: IChatWidgetService, languageModelToolsService: ILanguageModelToolsService): Promise<void> {

		// Ensure auth extension is enabled before waiting for chat readiness.
		// This must run before the readiness event listeners are set up because
		// updateRunningExtensions restarts all extension hosts.
		const authExtensionReEnabled = await maybeEnableAuthExtension(this.extensionsWorkbenchService, this.logService);
		if (authExtensionReEnabled) {
			refreshTokens(this.commandService);
		}

		const widget = chatWidgetService.getWidgetBySessionResource(requestModel.session.sessionResource);
		const modeInfo = widget?.input.currentModeInfo;

		// We need a signal to know when we can resend the request to
		// Chat. Waiting for the registration of the agent is not
		// enough, we also need a language/tools model to be available.

		let agentActivated = false;
		let agentReady = false;
		let languageModelReady = false;
		let toolsModelReady = false;

		const whenAgentActivated = this.whenAgentActivated(chatService).then(() => agentActivated = true);
		const whenAgentReady = this.whenAgentReady(chatAgentService, modeInfo?.kind)?.then(() => agentReady = true);
		if (!whenAgentReady) {
			agentReady = true;
		}
		const whenLanguageModelReady = this.whenLanguageModelReady(languageModelsService, requestModel.modelId)?.then(() => languageModelReady = true);
		if (!whenLanguageModelReady) {
			languageModelReady = true;
		}
		const whenToolsModelReady = this.whenToolsModelReady(languageModelToolsService, requestModel)?.then(() => toolsModelReady = true);
		if (!whenToolsModelReady) {
			toolsModelReady = true;
		}

		if (whenLanguageModelReady instanceof Promise || whenAgentReady instanceof Promise || whenToolsModelReady instanceof Promise) {
			const timeoutHandle = setTimeout(() => {
				progress({
					kind: 'progressMessage',
					content: new MarkdownString(localize('waitingChat2', "Chat is almost ready")),
					shimmer: true,
				});
			}, 10000);

			const disposables = new DisposableStore();
			disposables.add(toDisposable(() => clearTimeout(timeoutHandle)));
			try {
				const ready = await Promise.race([
					timeout(this.environmentService.remoteAuthority ? 60000 /* increase for remote scenarios */ : 20000).then(() => 'timedout'),
					this.whenPanelAgentHasGuidance(disposables).then(() => 'panelGuidance'),
					Promise.allSettled([
						whenAgentActivated,
						whenAgentReady,
						whenLanguageModelReady,
						whenToolsModelReady
					])
				]);

				if (ready === 'panelGuidance') {
					const warningMessage = localize('chatTookLongWarningExtension', "Please try again.");

					progress({
						kind: 'markdownContent',
						content: new MarkdownString(warningMessage)
					});

					// This means Chat is unhealthy and we cannot retry the
					// request. Signal this to the outside via an event.
					this._onUnresolvableError.fire();
					return;
				}

				if (ready === 'timedout') {
					let warningMessage: string;
					if (this.chatEntitlementService.anonymous) {
						warningMessage = localize('chatTookLongWarningAnonymous', "Chat took too long to get ready. Please ensure that the extension `{0}` is installed and enabled. Click restart to try again if this issue persists.", defaultChat.chatExtensionId);
					} else {
						warningMessage = localize('chatTookLongWarning', "Chat took too long to get ready. Please ensure you are signed in to {0} and that the extension `{1}` is installed and enabled. Click restart to try again if this issue persists.", defaultChat.provider.default.name, defaultChat.chatExtensionId);
					}

					// Compute language model diagnostic info
					const languageModelIds = languageModelsService.getLanguageModelIds();
					let languageModelDefaultCount = 0;
					for (const id of languageModelIds) {
						const model = languageModelsService.lookupLanguageModel(id);
						if (model?.isDefaultForLocation[ChatAgentLocation.Chat]) {
							languageModelDefaultCount++;
						}
					}

					// Compute agent diagnostic info
					const defaultAgent = chatAgentService.getDefaultAgent(this.location, modeInfo?.kind);
					const agentHasDefault = !!defaultAgent;
					const agentDefaultIsCore = defaultAgent?.isCore ?? false;
					const contributedDefaultAgent = chatAgentService.getContributedDefaultAgent(this.location);
					const agentHasContributedDefault = !!contributedDefaultAgent;
					const agentContributedDefaultIsCore = contributedDefaultAgent?.isCore ?? false;
					const agentActivatedCount = chatAgentService.getActivatedAgents().length;

					this.logService.warn(warningMessage, {
						agentActivated,
						agentReady,
						agentHasDefault,
						agentDefaultIsCore,
						agentHasContributedDefault,
						agentContributedDefaultIsCore,
						agentActivatedCount,
						agentLocation: this.location,
						agentModeKind: modeInfo?.kind,
						languageModelReady,
						languageModelCount: languageModelIds.length,
						languageModelDefaultCount,
						languageModelHasRequestedModel: !!requestModel.modelId,
						toolsModelReady
					});

					type ChatSetupTimeoutClassification = {
						owner: 'chrmarti';
						comment: 'Provides insight into chat setup timeouts.';
						agentActivated: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether the agent was activated.' };
						agentReady: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether the agent was ready.' };
						agentHasDefault: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether a default agent exists for the location and mode.' };
						agentDefaultIsCore: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether the default agent is a core agent.' };
						agentHasContributedDefault: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether a contributed default agent exists for the location.' };
						agentContributedDefaultIsCore: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether the contributed default agent is a core agent.' };
						agentActivatedCount: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'Number of activated agents at timeout.' };
						agentLocation: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The chat agent location.' };
						agentModeKind: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The chat mode kind.' };
						languageModelReady: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether the language model was ready.' };
						languageModelCount: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'Number of registered language models at timeout.' };
						languageModelDefaultCount: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; isMeasurement: true; comment: 'Number of language models with isDefaultForLocation[Chat] set.' };
						languageModelHasRequestedModel: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether a specific model ID was requested.' };
						toolsModelReady: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether the tools model was ready.' };
						isRemote: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether this is a remote scenario.' };
						isAnonymous: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether anonymous access is enabled.' };
						matchingWelcomeViewWhen: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The when clause of the matching extension welcome view, if any.' };
					};
					type ChatSetupTimeoutEvent = {
						agentActivated: boolean;
						agentReady: boolean;
						agentHasDefault: boolean;
						agentDefaultIsCore: boolean;
						agentHasContributedDefault: boolean;
						agentContributedDefaultIsCore: boolean;
						agentActivatedCount: number;
						agentLocation: string;
						agentModeKind: string;
						languageModelReady: boolean;
						languageModelCount: number;
						languageModelDefaultCount: number;
						languageModelHasRequestedModel: boolean;
						toolsModelReady: boolean;
						isRemote: boolean;
						isAnonymous: boolean;
						matchingWelcomeViewWhen: string;
					};
					const chatViewPane = this.viewsService.getActiveViewWithId(ChatViewId) as ChatViewPane | undefined;
					const matchingWelcomeView = chatViewPane?.getMatchingWelcomeView();

					this.telemetryService.publicLog2<ChatSetupTimeoutEvent, ChatSetupTimeoutClassification>('chatSetup.timeout', {
						agentActivated,
						agentReady,
						agentHasDefault,
						agentDefaultIsCore,
						agentHasContributedDefault,
						agentContributedDefaultIsCore,
						agentActivatedCount,
						agentLocation: this.location,
						agentModeKind: modeInfo?.kind ?? '',
						languageModelReady,
						languageModelCount: languageModelIds.length,
						languageModelDefaultCount,
						languageModelHasRequestedModel: !!requestModel.modelId,
						toolsModelReady,
						isRemote: !!this.environmentService.remoteAuthority,
						isAnonymous: this.chatEntitlementService.anonymous,
						matchingWelcomeViewWhen: matchingWelcomeView?.when.serialize() ?? (chatViewPane ? 'noWelcomeView' : 'noChatViewPane'),
					});

					progress({
						kind: 'warning',
						content: new MarkdownString(warningMessage)
					});

					if (defaultChat.outputChannelId && this.outputService.getChannelDescriptor(defaultChat.outputChannelId)) {
						progress({
							kind: 'command',
							command: {
								id: SetupAgent.CHAT_SHOW_OUTPUT_COMMAND_ID,
								title: localize('showNeoAgentsChatDetails', "Show Details")
							}
						});
					} else {
						progress({
							kind: 'command',
							command: {
								id: SetupAgent.CHAT_RETRY_COMMAND_ID,
								title: localize('retryChat', "Restart"),
								arguments: [requestModel.session.sessionResource]
							}
						});
					}

					// This means Chat is unhealthy and we cannot retry the
					// request. Signal this to the outside via an event.
					this._onUnresolvableError.fire();
					return;
				}
			} finally {
				disposables.dispose();
			}
		}

		await chatService.resendRequest(requestModel, {
			...widget?.getModeRequestOptions(),
			modeInfo,
			userSelectedModelId: widget?.input.currentLanguageModel
		});
	}

	private async whenPanelAgentHasGuidance(disposables: DisposableStore): Promise<void> {
		const panelAgentHasGuidance = () => chatViewsWelcomeRegistry.get().some(descriptor => this.contextKeyService.contextMatchesRules(descriptor.when));

		if (panelAgentHasGuidance()) {
			return;
		}

		return new Promise<void>(resolve => {
			let descriptorKeys: Set<string> = new Set();
			const updateDescriptorKeys = () => {
				const descriptors = chatViewsWelcomeRegistry.get();
				descriptorKeys = new Set(descriptors.flatMap(d => d.when.keys()));
			};
			updateDescriptorKeys();

			const onDidChangeRegistry = Event.map(chatViewsWelcomeRegistry.onDidChange, () => 'registry' as const);
			const onDidChangeRelevantContext = Event.map(
				Event.filter(this.contextKeyService.onDidChangeContext, e => e.affectsSome(descriptorKeys)),
				() => 'context' as const
			);

			disposables.add(Event.any(
				onDidChangeRegistry,
				onDidChangeRelevantContext
			)(source => {
				if (source === 'registry') {
					updateDescriptorKeys();
				}
				if (panelAgentHasGuidance()) {
					resolve();
				}
			}));
		});
	}

	private whenLanguageModelReady(languageModelsService: ILanguageModelsService, modelId: string | undefined): Promise<unknown> | void {
		const hasModelForRequest = () => {
			if (modelId) {
				return !!languageModelsService.lookupLanguageModel(modelId);
			}

			for (const id of languageModelsService.getLanguageModelIds()) {
				const model = languageModelsService.lookupLanguageModel(id);
				if (model?.isDefaultForLocation[ChatAgentLocation.Chat]) {
					return true;
				}
			}

			return false;
		};

		if (hasModelForRequest()) {
			return;
		}

		return Event.toPromise(Event.filter(languageModelsService.onDidChangeLanguageModels, () => hasModelForRequest()));
	}

	private whenToolsModelReady(languageModelToolsService: ILanguageModelToolsService, requestModel: IChatRequestModel): Promise<unknown> | void {
		const needsToolsModel = requestModel.message.parts.some(part => part instanceof ChatRequestToolPart);
		if (!needsToolsModel) {
			return; // No tools in this request, no need to check
		}

		// check that tools other than setup. and internal tools are registered.
		for (const tool of languageModelToolsService.getAllToolsIncludingDisabled()) {
			if (tool.id.startsWith('neo_agents_')) {
				return; // we have tools!
			}
		}

		return Event.toPromise(Event.filter(languageModelToolsService.onDidChangeTools, () => {
			for (const tool of languageModelToolsService.getAllToolsIncludingDisabled()) {
				if (tool.id.startsWith('neo_agents_')) {
					return true; // we have tools!
				}
			}

			return false; // no external tools found
		}));
	}

	private whenAgentReady(chatAgentService: IChatAgentService, mode: ChatModeKind | undefined): Promise<unknown> | void {
		const defaultAgent = chatAgentService.getDefaultAgent(this.location, mode);
		if (defaultAgent && !defaultAgent.isCore) {
			return; // we have a default agent from an extension!
		}

		return Event.toPromise(Event.filter(chatAgentService.onDidChangeAgents, () => {
			const defaultAgent = chatAgentService.getDefaultAgent(this.location, mode);
			return Boolean(defaultAgent && !defaultAgent.isCore);
		}));
	}

	private async whenAgentActivated(chatService: IChatService): Promise<void> {
		try {
			await chatService.activateDefaultAgent(this.location);
		} catch (error) {
			this.logService.error(error);
		}
	}

	private async doInvokeWithSetup(request: IChatAgentRequest, progress: (part: IChatProgress) => void, chatService: IChatService, languageModelsService: ILanguageModelsService, chatWidgetService: IChatWidgetService, chatAgentService: IChatAgentService, languageModelToolsService: ILanguageModelToolsService, defaultAccountService: IDefaultAccountService): Promise<IChatAgentResult> {
		this.telemetryService.publicLog2<WorkbenchActionExecutedEvent, WorkbenchActionExecutedClassification>('workbenchActionExecuted', { id: CHAT_SETUP_ACTION_ID, from: 'chat' });

		const widget = chatWidgetService.getWidgetBySessionResource(request.sessionResource);
		const requestModel = widget?.viewModel?.model.getRequests().at(-1);

		const setupListener = Event.runAndSubscribe(this.controller.value.onDidChange, (() => {
			switch (this.controller.value.step) {
				case ChatSetupStep.SigningIn:
					progress({
						kind: 'progressMessage',
						content: new MarkdownString(localize('setupChatSignIn2', "Signing in to {0}", defaultAccountService.getDefaultAccountAuthenticationProvider().name)),
						shimmer: true,
					});
					break;
				case ChatSetupStep.Installing:
					progress({
						kind: 'progressMessage',
						content: new MarkdownString(localize('installingChat', "Getting chat ready")),
						shimmer: true,
					});
					break;
			}
		}));

		let result: IChatSetupResult | undefined = undefined;
		try {
			result = await ChatSetup.getInstance(this.instantiationService, this.context, this.controller).run({
				disableChatViewReveal: true, 																				// we are already in a chat context
				forceAnonymous: this.chatEntitlementService.anonymous ? ChatSetupAnonymous.EnabledWithoutDialog : undefined	// only enable anonymous selectively
			});
		} catch (error) {
			this.logService.error(`[chat setup] Error during setup: ${toErrorMessage(error)}`);
		} finally {
			setupListener.dispose();
		}

		// User has agreed to run the setup
		if (typeof result?.success === 'boolean') {
			if (result.success) {
				if (result.dialogSkipped) {
					await widget?.clear(); // make room for the Chat welcome experience
				} else if (requestModel) {
					let newRequest = this.replaceAgentInRequestModel(requestModel, chatAgentService); 	// Replace agent part with the actual Chat agent...
					newRequest = this.replaceToolInRequestModel(newRequest); 							// ...then replace any tool parts with the actual Chat tools

					await this.forwardRequestToChat(newRequest, progress, chatService, languageModelsService, chatAgentService, chatWidgetService, languageModelToolsService);
				}
			} else {
				progress({
					kind: 'warning',
					content: new MarkdownString(localize('chatSetupError', "Chat setup failed."))
				});
			}
		}

		// User has cancelled the setup
		else {
			progress({
				kind: 'markdownContent',
				content: this.workspaceTrustManagementService.isWorkspaceTrusted() ? SetupAgent.SETUP_NEEDED_MESSAGE : SetupAgent.TRUST_NEEDED_MESSAGE
			});
		}

		return {};
	}

	private replaceAgentInRequestModel(requestModel: IChatRequestModel, chatAgentService: IChatAgentService): IChatRequestModel {
		const agentPart = requestModel.message.parts.find((r): r is ChatRequestAgentPart => r instanceof ChatRequestAgentPart);
		if (!agentPart) {
			return requestModel;
		}

		const agentId = agentPart.agent.id.replace(/setup\./, `${defaultChat.extensionId}.`.toLowerCase());
		const githubAgent = chatAgentService.getAgent(agentId);
		if (!githubAgent) {
			return requestModel;
		}

		const newAgentPart = new ChatRequestAgentPart(agentPart.range, agentPart.editorRange, githubAgent);

		return new ChatRequestModel({
			session: requestModel.session as ChatModel,
			message: {
				parts: requestModel.message.parts.map(part => {
					if (part instanceof ChatRequestAgentPart) {
						return newAgentPart;
					}
					return part;
				}),
				text: requestModel.message.text
			},
			variableData: requestModel.variableData,
			timestamp: Date.now(),
			attempt: requestModel.attempt,
			modeInfo: requestModel.modeInfo,
			confirmation: requestModel.confirmation,
			locationData: requestModel.locationData,
			attachedContext: requestModel.attachedContext,
			isCompleteAddedRequest: requestModel.isCompleteAddedRequest,
		});
	}

	private replaceToolInRequestModel(requestModel: IChatRequestModel): IChatRequestModel {
		const toolPart = requestModel.message.parts.find((r): r is ChatRequestToolPart => r instanceof ChatRequestToolPart);
		if (!toolPart) {
			return requestModel;
		}

		const toolId = toolPart.toolId.replace(/setup.tools\./, `neo_agents_`.toLowerCase());
		const newToolPart = new ChatRequestToolPart(
			toolPart.range,
			toolPart.editorRange,
			toolPart.toolName,
			toolId,
			toolPart.displayName,
			toolPart.icon
		);

		const chatRequestToolEntry: IChatRequestToolEntry = {
			id: toolId,
			name: 'new',
			range: toolPart.range,
			kind: 'tool',
			value: undefined
		};

		const variableData: IChatRequestVariableData = {
			variables: [chatRequestToolEntry]
		};

		return new ChatRequestModel({
			session: requestModel.session as ChatModel,
			message: {
				parts: requestModel.message.parts.map(part => {
					if (part instanceof ChatRequestToolPart) {
						return newToolPart;
					}
					return part;
				}),
				text: requestModel.message.text
			},
			variableData: variableData,
			timestamp: Date.now(),
			attempt: requestModel.attempt,
			modeInfo: requestModel.modeInfo,
			confirmation: requestModel.confirmation,
			locationData: requestModel.locationData,
			attachedContext: [chatRequestToolEntry],
			isCompleteAddedRequest: requestModel.isCompleteAddedRequest,
		});
	}

	private async doInvokeQwenCode(request: IChatAgentRequest, progress: (part: IChatProgress) => void, provider: INeocodeSwarmProviderConfig, config: INeocodeSwarmConfig, history: IChatAgentHistoryEntry[], token: CancellationToken): Promise<IChatAgentResult> {
		const runner = this.instantiationService.createInstance(QwenCodeAgentRunner);
		const secret = await this.getProviderSecretWithFallback(provider, provider.authMethod === 'qwen-oauth' ? 'loginToken' : 'apiKey');
		const inlineEditContext = await this.resolveInlineEditContext(request);
		this.notifyMissingInlineEditContextIfNeeded(request, inlineEditContext, progress);
		const effectiveUserMessage = this.resolveEffectiveUserMessage(request.message, history);
		const contextualUserMessage = await this.buildPromptWithAttachedCodeContext(request, effectiveUserMessage, inlineEditContext);
		const prompt = inlineEditContext
			? this.buildInlineEditPrompt(contextualUserMessage, inlineEditContext.selectedText)
			: contextualUserMessage;
		const referencedFiles = await this.collectReferencedFilePaths(request, inlineEditContext);
		const taskMode: 'plan' | 'default' | 'auto-edit' =
			inlineEditContext
				? 'auto-edit'
				: (config.advanced.isDeveloperMode ? 'default' : 'plan');

		progress({ kind: 'progressMessage', content: new MarkdownString(localize('qwenCodeInvoking', "Neo Agents: Executing via QwenCode...")) });

		const disposables = new DisposableStore();
		disposables.add(runner);
		disposables.add(runner.onEvent(e => {
			if (e.type === 'assistant' && e.content) {
				progress({ kind: 'markdownContent', content: new MarkdownString(e.content) });
			} else if (e.type === 'system' && e.content) {
				progress({ kind: 'progressMessage', content: new MarkdownString(e.content) });
			}
		}));

		try {
			await runner.runTask(provider, {
				prompt,
				mode: taskMode,
				files: referencedFiles
			}, secret, token);
			return {};
		} finally {
			disposables.dispose();
		}
	}
}

export class SetupTool implements IToolImpl {

	static registerTool(instantiationService: IInstantiationService, toolData: IToolData): IDisposable {
		return instantiationService.invokeFunction(accessor => {
			const toolService = accessor.get(ILanguageModelToolsService);

			const tool = instantiationService.createInstance(SetupTool);
			return toolService.registerTool(toolData, tool);
		});
	}

	async invoke(invocation: IToolInvocation, countTokens: CountTokensCallback, progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const result: IToolResult = {
			content: [
				{
					kind: 'text',
					value: ''
				}
			]
		};

		return result;
	}

	async prepareToolInvocation?(parameters: unknown, token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		return undefined;
	}
}

export class AINewSymbolNamesProvider {

	static registerProvider(instantiationService: IInstantiationService, context: ChatEntitlementContext, controller: Lazy<ChatSetupController>): IDisposable {
		return instantiationService.invokeFunction(accessor => {
			const languageFeaturesService = accessor.get(ILanguageFeaturesService);

			const provider = instantiationService.createInstance(AINewSymbolNamesProvider, context, controller);
			return languageFeaturesService.newSymbolNamesProvider.register('*', provider);
		});
	}

	constructor(
		private readonly context: ChatEntitlementContext,
		private readonly controller: Lazy<ChatSetupController>,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IChatEntitlementService private readonly chatEntitlementService: IChatEntitlementService,
	) {
	}

	async provideNewSymbolNames(model: ITextModel, range: IRange, triggerKind: NewSymbolNameTriggerKind, token: CancellationToken): Promise<NewSymbolName[] | undefined> {
		await this.instantiationService.invokeFunction(accessor => {
			return ChatSetup.getInstance(this.instantiationService, this.context, this.controller).run({
				forceAnonymous: this.chatEntitlementService.anonymous ? ChatSetupAnonymous.EnabledWithDialog : undefined
			});
		});

		return [];
	}
}

export class ChatCodeActionsProvider {

	static registerProvider(instantiationService: IInstantiationService): IDisposable {
		return instantiationService.invokeFunction(accessor => {
			const languageFeaturesService = accessor.get(ILanguageFeaturesService);

			const provider = instantiationService.createInstance(ChatCodeActionsProvider);
			return languageFeaturesService.codeActionProvider.register('*', provider);
		});
	}

	constructor(
		@IMarkerService private readonly markerService: IMarkerService,
	) {
	}

	async provideCodeActions(model: ITextModel, range: Range | Selection): Promise<CodeActionList | undefined> {
		const actions: CodeAction[] = [];

		// "Generate" if the line is whitespace only
		// "Modify" if there is a selection
		let generateOrModifyTitle: string | undefined;
		let generateOrModifyCommand: Command | undefined;
		if (range.isEmpty()) {
			const textAtLine = model.getLineContent(range.startLineNumber);
			if (/^\s*$/.test(textAtLine)) {
				generateOrModifyTitle = localize('generate', "Generate");
				generateOrModifyCommand = AICodeActionsHelper.generate(range);
			}
		} else {
			const textInSelection = model.getValueInRange(range);
			if (!/^\s*$/.test(textInSelection)) {
				generateOrModifyTitle = localize('modify', "Modify");
				generateOrModifyCommand = AICodeActionsHelper.modify(range);
			}
		}

		if (generateOrModifyTitle && generateOrModifyCommand) {
			actions.push({
				kind: CodeActionKind.RefactorRewrite.append('neo_agents').value,
				isAI: true,
				title: generateOrModifyTitle,
				command: generateOrModifyCommand,
			});
		}

		const markers = AICodeActionsHelper.warningOrErrorMarkersAtRange(this.markerService, model.uri, range);
		if (markers.length > 0) {

			// "Fix" if there are diagnostics in the range
			actions.push({
				kind: CodeActionKind.QuickFix.append('neo_agents').value,
				isAI: true,
				diagnostics: markers,
				title: localize('fix', "Fix"),
				command: AICodeActionsHelper.fixMarkers(markers, range)
			});

			// "Explain" if there are diagnostics in the range
			actions.push({
				kind: CodeActionKind.QuickFix.append('explain').append('neo_agents').value,
				isAI: true,
				diagnostics: markers,
				title: localize('explain', "Explain"),
				command: AICodeActionsHelper.explainMarkers(markers)
			});
		}

		return {
			actions,
			dispose() { }
		};
	}
}

export class AICodeActionsHelper {

	static warningOrErrorMarkersAtRange(markerService: IMarkerService, resource: URI, range: Range | Selection): IMarker[] {
		return markerService
			.read({ resource, severities: MarkerSeverity.Error | MarkerSeverity.Warning })
			.filter(marker => range.startLineNumber <= marker.endLineNumber && range.endLineNumber >= marker.startLineNumber);
	}

	static modify(range: Range): Command {
		return {
			id: INLINE_CHAT_START,
			title: localize('modify', "Modify"),
			arguments: [
				{
					initialSelection: this.rangeToSelection(range),
					initialRange: range,
					position: range.getStartPosition()
				} satisfies { initialSelection: ISelection; initialRange: IRange; position: IPosition }
			]
		};
	}

	static generate(range: Range): Command {
		return {
			id: INLINE_CHAT_START,
			title: localize('generate', "Generate"),
			arguments: [
				{
					initialSelection: this.rangeToSelection(range),
					initialRange: range,
					position: range.getStartPosition()
				} satisfies { initialSelection: ISelection; initialRange: IRange; position: IPosition }
			]
		};
	}

	private static rangeToSelection(range: Range): ISelection {
		return new Selection(range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn);
	}

	static explainMarkers(markers: IMarker[]): Command {
		return {
			id: CHAT_OPEN_ACTION_ID,
			title: localize('explain', "Explain"),
			arguments: [
				{
					query: `@workspace /explain ${markers.map(marker => marker.message).join(', ')}`,
					isPartialQuery: true
				} satisfies { query: string; isPartialQuery: boolean }
			]
		};
	}

	static fixMarkers(markers: IMarker[], range: Range): Command {
		return {
			id: INLINE_CHAT_START,
			title: localize('fix', "Fix"),
			arguments: [
				{
					message: `/fix ${markers.map(marker => marker.message).join(', ')}`,
					initialSelection: this.rangeToSelection(range),
					initialRange: range,
					position: range.getStartPosition()
				} satisfies { message: string; initialSelection: ISelection; initialRange: IRange; position: IPosition }
			]
		};
	}

}

function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.trim().replace(/\/+$/, '');
}

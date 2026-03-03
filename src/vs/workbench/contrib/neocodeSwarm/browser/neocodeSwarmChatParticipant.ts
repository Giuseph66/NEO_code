/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
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
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { INeocodeSwarmStorageService, INeocodeSwarmSecretService } from '../common/neocodeSwarmStorage.js';
import { INeocodeSwarmConfig, INeocodeSwarmProviderConfig, NeocodeSwarmProviderType } from '../common/neocodeSwarmTypes.js';
import { QwenRuntimeAdapter, IQwenSdkTaskOptions } from '../../neocode/qwen/browser/qwenRuntimeAdapter.js';
import { IGeminiAuthService } from '../../neocode/gemini/common/geminiTypes.js';
import { IQwenAuthService, IQwenRuntimeEnvResult, QwenProtocol } from '../../neocode/qwen/common/qwenTypes.js';
import { isOpenAITokenExpiredOrNearExpiry, parseStoredOpenAITokenBundle, refreshOpenAITokenBundle } from './neocodeSwarmOpenAIOAuthController.js';
import { IChannel, ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { INeocodeSwarmCliExecService, NEO_SWARM_CLI_EXEC_CHANNEL } from '../common/neocodeSwarmCliExecTypes.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { NeocodeSwarmToolExecutor, buildCodeEditingSystemPrompt } from './neocodeSwarmToolExecutor.js';
import { NeocodeSwarmOrchestrator, buildProviderConfig, buildEnvFromProvider } from './neocodeSwarmOrchestrator.js';
import { INeocodeSwarmActivityService } from './neocodeSwarmActivityService.js';
import { NeocodeSwarmActivityEditorInput } from './neocodeSwarmActivityPanel.js';

const NEO_PARTICIPANT_ID = 'neocode.swarm';

const SWARM_CLI_EXEC_WORKER_MODULE_ID = 'vs/workbench/contrib/neocodeSwarm/node/neocodeSwarmCliExecMain';

interface IUtilityProcessWorkerHandle {
	client: { getChannel(channelName: string): IChannel };
	dispose(): void;
}

interface IUtilityProcessWorkerServiceLike {
	createWorker(process: { moduleId: string; type: string; name: string }): Promise<IUtilityProcessWorkerHandle>;
}

/**
 * A resolved credential ready to be used for a provider invocation.
 * The kind distinguishes which invocation path to use.
 */
type INeocodeCredential =
	/** Plain API key or Gemini OAuth Bearer token — QwenRuntimeAdapter path */
	| { kind: 'bearer'; token: string }
	/** Qwen Code OAuth session — QwenRuntimeAdapter with qwen-oauth authType */
	| { kind: 'qwen-oauth'; rawToken: string; envData: IQwenRuntimeEnvResult }
	/** OpenAI browser login — `codex exec --experimental-json` subprocess */
	| { kind: 'codex-cli'; accessToken?: string }
	/** Anthropic Claude CLI login — `claude -p` subprocess */
	| { kind: 'anthropic-cli' };

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
 * When swarm mode is enabled, routes tasks through the multi-agent orchestrator.
 * Otherwise falls back to single-provider mode.
 */
export class NeocodeSwarmChatParticipant extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.neocodeSwarmChatParticipant';

	private adapter: QwenRuntimeAdapter | undefined;
	private toolExecutor: NeocodeSwarmToolExecutor | undefined;
	private activityEditorInput: NeocodeSwarmActivityEditorInput | undefined;

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
		@IEditorService private readonly editorService: IEditorService,
		@INeocodeSwarmActivityService private readonly activityService: INeocodeSwarmActivityService,
		@IGeminiAuthService private readonly geminiAuthService: IGeminiAuthService,
		@IQwenAuthService private readonly qwenAuthService: IQwenAuthService,
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
				{ name: 'swarm', description: localize('neoSwarmSwarmCmd', "Force multi-agent swarm execution") },
				...this.storageService.load().capabilities?.commands
					.filter(c => c.name && !['plan', 'edit', 'review', 'swarm'].includes(c.name))
					.map(c => ({
						name: c.name.replace(/^[a-z]+-/, ''),
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

		// Auto-open activity panel when agents are spawned
		this._register(this.activityService.onDidStartSession(() => this.openActivityPanel()));
	}

	private async invoke(
		request: IChatAgentRequest,
		progress: (parts: IChatProgress[]) => void,
		_history: IChatAgentHistoryEntry[],
		token: CancellationToken = CancellationToken.None,
	): Promise<IChatAgentResult> {
		const config = this.storageService.load();
		const providers = config.providers.filter(p => p.enabled);

		if (providers.length === 0) {
			progress([{
				kind: 'markdownContent',
				content: new MarkdownString(localize('neoNoProviders', "**NeoCode:** No providers configured. Open **NeoCode: Configurar Enxame de Agentes** to add a provider.")),
			}]);
			return {};
		}

		// Try the configured orchestrator provider first, then fall back to any provider with credentials.
		const preferredProvider = providers.find(p => p.id === config.orchestrator.providerId);
		const candidates = preferredProvider
			? [preferredProvider, ...providers.filter(p => p.id !== preferredProvider.id)]
			: providers;

		// Resolve single-agent credential: first provider with any valid credential.
		let provider = candidates[0];
		let credential: INeocodeCredential | undefined;
		for (const candidate of candidates) {
			const cred = await this.resolveCredential(candidate);
			if (cred) {
				provider = candidate;
				credential = cred;
				break;
			}
		}

		if (!credential) {
			const providerList = providers.map(p => `- **${p.name}** (${p.type}, auth: ${p.authMethod})`).join('\n');
			progress([{
				kind: 'markdownContent',
				content: new MarkdownString(
					`**NeoCode @neo:** Nenhum provedor com credencial utilizável foi encontrado.\n\n` +
					`**Seus provedores configurados:**\n${providerList}\n\n` +
					`Acesse **NeoCode: Configurar Enxame de Agentes** e verifique se cada provedor está autenticado (API Key, Google Login, OpenAI Login, Claude CLI, Qwen OAuth).`
				),
			}]);
			return {};
		}

		// Resolve orchestrator credential separately: requires bearer or qwen-oauth for QwenRuntimeAdapter.
		// CLI-based credentials (anthropic-cli, codex-cli) cannot drive the orchestrator analysis/synthesis.
		// We search in the same priority order (preferred provider first) but skip incompatible credential kinds.
		let orchestratorProvider: INeocodeSwarmProviderConfig | undefined;
		let orchestratorCredential: INeocodeCredential | undefined;
		for (const candidate of candidates) {
			const cred = await this.resolveCredential(candidate);
			if (cred && (cred.kind === 'bearer' || cred.kind === 'qwen-oauth')) {
				orchestratorProvider = candidate;
				orchestratorCredential = cred;
				break;
			}
		}
		this.logService.info(`[neocode swarm] orchestratorProvider=${orchestratorProvider?.name ?? 'none'} (${orchestratorProvider?.type ?? '-'}) orchestratorCredKind=${orchestratorCredential?.kind ?? 'none'}`);


		const systemPrompt = await this.buildCapabilitySystemPrompt(config);

		let prompt = request.message;
		if (request.command) {
			const customCmd = config.capabilities?.commands.find(
				c => c.name === request.command || c.name.endsWith(`-${request.command}`),
			);
			if (customCmd?.executablePath) {
				const cmdInstructions = await this.loadCapabilityFile(customCmd.executablePath);
				if (cmdInstructions) {
					prompt = `${cmdInstructions}\n\n## User Request\n${prompt}`;
				}
			} else {
				if (request.command === 'plan') {
					prompt = `Plan (do not execute) the following task:\n\n${prompt}`;
				} else if (request.command === 'review') {
					prompt = `Review the following and provide actionable feedback:\n\n${prompt}`;
				} else if (request.command === 'edit') {
					prompt = `Edit files to complete the following task:\n\n${prompt}`;
				}
			}
		}

		const fileContext = this.buildFileContext(request);
		if (fileContext) {
			prompt = `${fileContext}\n\n${prompt}`;
		}

		const modelLabel = `${provider.name} › ${provider.selectedModel ?? provider.models[0] ?? 'default'}`;
		progress([{
			kind: 'progressMessage',
			content: new MarkdownString(localize('neoRunning', "_Running with {0} ({1})..._", provider.name, provider.selectedModel ?? provider.models[0] ?? '')),
		}]);
		this.logService.info(`[neocode swarm] Using provider: ${modelLabel} (authMethod: ${provider.authMethod}, type: ${provider.type}, credKind: ${credential.kind})`);

		// Lazily create the shared tool executor
		if (!this.toolExecutor) {
			this.toolExecutor = this._register(this.instantiationService.createInstance(NeocodeSwarmToolExecutor));
		}

		const editingSession = this.chatEditingService.getEditingSession(request.sessionResource);
		const chatModel = this.chatService.getSession(request.sessionResource);
		const responseModel = chatModel?.getRequests().find(r => r.id === request.requestId)?.response;

		// Orchestrator (multi-agent) requires a bearer/qwen-oauth credential for QwenRuntimeAdapter.
		// CLI-based credentials (anthropic-cli, codex-cli) can only drive single-provider mode.
		// We use the separately-resolved orchestratorCredential/orchestratorProvider pair.
		const activeAgents = config.agents.filter(a => a.active);
		const canUseOrchestrator = activeAgents.length > 0 && !!orchestratorCredential;
		const useOrchestrator = canUseOrchestrator;
		const forceMultiAgent = request.command === 'swarm';

		try {
			// Helper to invoke the agent (orchestrator or single provider).
			// When using the orchestrator, always use the bearer/qwen-oauth provider for analysis/synthesis.
			// For single-agent mode, use whichever credential was resolved first (may be CLI-based).
			const invokeAgent = () => useOrchestrator
				? this.invokeWithOrchestrator(prompt, orchestratorProvider!, orchestratorCredential!, systemPrompt, config, progress, token, forceMultiAgent)
				: this.runWithProvider(provider, credential, prompt, systemPrompt, progress, token);

			if (editingSession && responseModel) {
				const opId = Date.now();
				const undoStopId = generateUuid();

				// Only pass real file URIs to startExternalEdits.
				// Virtual editors (chatSessionInput:, chat-editing-text-model:, etc.) use
				// custom URI schemes with no registered filesystem provider, which would crash
				// startExternalEdits before the LLM is ever called.
				const openUris = this.codeEditorService.listCodeEditors()
					.map(editor => editor.getModel()?.uri)
					.filter((uri): uri is URI => uri !== undefined && uri.scheme === 'file');

				let editTrackingStarted = false;
				try {
					const startProgress = await editingSession.startExternalEdits(responseModel, opId, openUris, undoStopId);
					progress(startProgress);
					editTrackingStarted = true;
				} catch (editErr) {
					// Edit tracking unavailable — still run the agent without it.
					this.logService.warn('[neocode swarm] startExternalEdits failed, continuing without edit tracking:', editErr);
				}

				try {
					await invokeAgent();
				} finally {
					if (editTrackingStarted) {
						try {
							const stopProgress = await editingSession.stopExternalEdits(responseModel, opId);
							progress(stopProgress);
							await editingSession.show();
						} catch (stopErr) {
							this.logService.warn('[neocode swarm] stopExternalEdits failed:', stopErr);
						}
					}
				}
			} else {
				await invokeAgent();
			}
		} catch (error: unknown) {
			const msg = error instanceof Error ? error.message : String(error);
			this.logService.error('[neocode swarm] Chat participant error:', error);
			progress([{
				kind: 'markdownContent',
				content: new MarkdownString(`**NeoCode Error:** ${msg}`),
			}]);
			return { errorDetails: { message: msg } };
		}

		return {};
	}

	// ─── Orchestrator path ────────────────────────────────────────────────────

	private async invokeWithOrchestrator(
		prompt: string,
		provider: INeocodeSwarmProviderConfig,
		credential: INeocodeCredential,
		systemPrompt: string,
		config: INeocodeSwarmConfig,
		progress: (parts: IChatProgress[]) => void,
		token: CancellationToken,
		forceMultiAgent = false,
	): Promise<void> {
		if (!this.toolExecutor) {
			this.toolExecutor = this._register(this.instantiationService.createInstance(NeocodeSwarmToolExecutor));
		}

		// Extract a plain API key the orchestrator can pass to QwenRuntimeAdapter.
		const apiKey = credential.kind === 'bearer' ? credential.token
			: credential.kind === 'qwen-oauth' ? credential.rawToken
			: undefined;
		// For qwen-oauth, propagate the full env (including QWEN_OAUTH_RESOURCE_URL) so
		// the orchestrator builds requests against the correct resource endpoint.
		const extraEnv = credential.kind === 'qwen-oauth' ? credential.envData.env : undefined;

		// Use a per-invocation DisposableStore so the orchestrator and its resources
		// are cleaned up immediately after the task completes (not on participant dispose).
		const invokeStore = new DisposableStore();
		try {
			const orchestrator = invokeStore.add(this.instantiationService.createInstance(NeocodeSwarmOrchestrator));

			await orchestrator.execute({
				prompt,
				config,
				provider,
				apiKey,
				extraEnv,
				toolExecutor: this.toolExecutor,
				systemPrompt,
				sessionId: generateUuid(),
				forceMultiAgent,
				onProgress: progress,
				resolveApiKey: async (providerId: string) => {
					const agentProvider = config.providers.find(p => p.id === providerId && p.enabled);
					if (agentProvider) {
						const cred = await this.resolveCredential(agentProvider);
						if (!cred) { return undefined; }
						return cred.kind === 'bearer' ? cred.token
							: cred.kind === 'qwen-oauth' ? cred.rawToken
							: undefined;
					}
					return undefined;
				},
			}, token);
		} finally {
			invokeStore.dispose();
		}
	}

	// ─── Simple single-provider path ──────────────────────────────────────────

	private async runWithProvider(
		provider: INeocodeSwarmProviderConfig,
		credential: INeocodeCredential,
		prompt: string,
		systemPrompt: string,
		progress: (parts: IChatProgress[]) => void,
		token: CancellationToken = CancellationToken.None,
	): Promise<void> {
		// Dispatch to specialized handlers based on auth kind.
		if (credential.kind === 'codex-cli') {
			await this.runWithCodexCli(provider, credential.accessToken, prompt, systemPrompt, progress, token);
			return;
		}
		if (credential.kind === 'anthropic-cli') {
			await this.runWithAnthropicCli(provider, prompt, systemPrompt, progress, token);
			return;
		}

		// bearer or qwen-oauth → QwenRuntimeAdapter
		const rawToken = credential.kind === 'bearer' ? credential.token
			: credential.kind === 'qwen-oauth' ? credential.rawToken
			: undefined;
		const protocol = providerTypeToProtocol(provider.type);
		const envVarName = providerTypeToEnvVar(provider.type);
		// For qwen-oauth, leave baseUrl undefined so QwenRuntimeAdapter.resolveBaseUrl()
		// reads QWEN_OAUTH_RESOURCE_URL from the env (the correct OAuth resource endpoint).
		const baseUrl = credential.kind === 'qwen-oauth'
			? (provider.baseUrl?.trim() || undefined)
			: (provider.baseUrl ?? providerTypeToDefaultBaseUrl(provider.type));

		const providerConfig = {
			authType: credential.kind === 'qwen-oauth' ? 'qwen-oauth' as const : 'apiKey' as const,
			protocol,
			modelId: provider.selectedModel ?? provider.models[0] ?? 'default',
			displayName: provider.name,
			baseUrl,
			envVarName,
		};

		// For qwen-oauth, use the full envData (includes QWEN_OAUTH_RESOURCE_URL).
		// For other auth kinds, build env from the raw token only.
		const env: Record<string, string> = credential.kind === 'qwen-oauth'
			? { ...credential.envData.env }
			: {};
		if (rawToken && credential.kind !== 'qwen-oauth') {
			env[envVarName] = rawToken;
		}

		if (!this.toolExecutor) {
			this.toolExecutor = this._register(this.instantiationService.createInstance(NeocodeSwarmToolExecutor));
		}

		const sdkOptions: IQwenSdkTaskOptions = {
			prompt,
			includePartialMessages: true,
			permissionMode: 'default',
			toolExecutor: this.toolExecutor,
			systemPrompt,
			maxToolCallRounds: 15,
		};

		if (!this.adapter) {
			this.adapter = this._register(this.instantiationService.createInstance(QwenRuntimeAdapter));
		}

		const stream = this.adapter.runTask(providerConfig, { env, maskedEnv: {} }, sdkOptions, token);

		let hasContent = false;
		for await (const chunk of stream) {
			if (token.isCancellationRequested) { break; }

			if (chunk.type === 'content' && chunk.value) {
				hasContent = true;
				progress([{ kind: 'markdownContent', content: new MarkdownString(chunk.value) }]);
			} else if (chunk.type === 'tool_call' && chunk.toolName) {
				progress([{ kind: 'progressMessage', content: new MarkdownString(`_Executando: ${chunk.toolName}_`) }]);
			} else if (chunk.type === 'error' && chunk.error) {
				progress([{ kind: 'markdownContent', content: new MarkdownString(`**Erro:** ${chunk.error}`) }]);
			}
		}

		if (!hasContent) {
			progress([{ kind: 'markdownContent', content: new MarkdownString(localize('neoNoResponse', "_Provider returned no content._")) }]);
		}
	}

	// ─── OpenAI Codex CLI path (`codex exec --experimental-json`) ───────────

	private async runWithCodexCli(
		provider: INeocodeSwarmProviderConfig,
		accessToken: string | undefined,
		prompt: string,
		systemPrompt: string,
		progress: (parts: IChatProgress[]) => void,
		token: CancellationToken,
	): Promise<void> {
		const model = provider.selectedModel ?? provider.models[0] ?? '';

		// codex exec reads the prompt from stdin (like qwen/gemini-cli).
		// System instructions are prepended as part of the user message since
		// `codex exec` does not have a dedicated system-prompt flag.
		const fullPrompt = systemPrompt?.trim()
			? `${systemPrompt.trim()}\n\n${prompt}`
			: prompt;

		// `codex exec --experimental-json` streams JSONL events to stdout.
		const cliArgs = ['exec', '--experimental-json'];
		if (model) {
			cliArgs.push('--model', model);
		}

		// Pass the OAuth access token as OPENAI_API_KEY so the binary can
		// authenticate without requiring a prior `codex login` session.
		// If no token is stored, the binary falls back to ~/.codex/ credentials.
		const extraEnv: Record<string, string> = {};
		if (accessToken?.trim()) {
			extraEnv['OPENAI_API_KEY'] = accessToken;
		}

		this.logService.info(`[neocode swarm] Codex CLI: running "codex ${cliArgs.join(' ')}" (promptLen=${fullPrompt.length} hasToken=${!!accessToken})`);

		let worker: IUtilityProcessWorkerHandle | undefined;
		try {
			const execService = await this.createCliExecWorker();
			worker = execService.worker;

			if (token.isCancellationRequested) { return; }

			const result = await execService.service.exec({
				command: 'codex',
				args: cliArgs,
				stdin: fullPrompt,
				env: extraEnv,
				timeoutMs: 180_000,
			});

			this.logService.info(`[neocode swarm] Codex CLI: exitCode=${result.exitCode} stdoutLen=${result.stdout.length} stderrLen=${result.stderr?.length ?? 0}`);
			if (result.stdout) {
				this.logService.info(`[neocode swarm] Codex CLI stdout preview: ${result.stdout.slice(0, 300)}`);
			}
			if (result.stderr) {
				this.logService.warn(`[neocode swarm] Codex CLI stderr: ${result.stderr.slice(0, 300)}`);
			}

			if (result.exitCode !== 0) {
				const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
				progress([{ kind: 'markdownContent', content: new MarkdownString(`**NeoCode Codex CLI:** ${detail || 'Falha ao executar codex exec.'}`) }]);
				return;
			}

			const text = this.extractCodexCliText(result.stdout);
			if (text) {
				progress([{ kind: 'markdownContent', content: new MarkdownString(text) }]);
			} else {
				progress([{ kind: 'markdownContent', content: new MarkdownString(localize('neoNoResponse', "_Provider returned no content._")) }]);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.logService.error('[neocode swarm] Codex CLI invocation failed:', err);
			progress([{ kind: 'markdownContent', content: new MarkdownString(`**NeoCode Codex CLI:** ${msg}`) }]);
		} finally {
			worker?.dispose();
		}
	}

	// ─── Anthropic CLI path ───────────────────────────────────────────────────

	private async runWithAnthropicCli(
		provider: INeocodeSwarmProviderConfig,
		prompt: string,
		systemPrompt: string,
		progress: (parts: IChatProgress[]) => void,
		token: CancellationToken,
	): Promise<void> {
		const model = provider.selectedModel ?? provider.models[0] ?? '';
		const fullPrompt = systemPrompt?.trim()
			? `System:\n${systemPrompt.trim()}\n\nUser:\n${prompt}`
			: prompt;

		// Use -p (print / non-interactive) mode.
		// Avoid --output-format json — older claude CLI versions do not support it
		// and exit immediately with code 128 (signal killed) producing no output.
		const cliArgs = ['-p'];
		if (model && /^claude-/i.test(model)) {
			cliArgs.push('--model', model);
		}

		this.logService.info(`[neocode swarm] Anthropic CLI: running "claude ${cliArgs.join(' ')}" (prompt length: ${fullPrompt.length})`);

		let worker: IUtilityProcessWorkerHandle | undefined;
		try {
			const execService = await this.createCliExecWorker();
			worker = execService.worker;

			if (token.isCancellationRequested) { return; }

			const result = await execService.service.exec({
				command: 'claude',
				args: cliArgs,
				stdin: fullPrompt,
				timeoutMs: 180_000,
			});

			this.logService.info(`[neocode swarm] Anthropic CLI: exitCode=${result.exitCode} stdoutLen=${result.stdout.length} stderrLen=${result.stderr?.length ?? 0}`);
			if (result.stdout) {
				this.logService.info(`[neocode swarm] Anthropic CLI stdout preview: ${result.stdout.slice(0, 300)}`);
			}
			if (result.stderr) {
				this.logService.warn(`[neocode swarm] Anthropic CLI stderr: ${result.stderr.slice(0, 300)}`);
			}

			if (result.exitCode !== 0) {
				const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
				progress([{ kind: 'markdownContent', content: new MarkdownString(`**NeoCode Anthropic CLI:** ${detail || 'Falha ao executar Claude CLI.'}`) }]);
				return;
			}

			const text = this.extractClaudeCliText(result.stdout);
			if (text) {
				progress([{ kind: 'markdownContent', content: new MarkdownString(text) }]);
			} else {
				progress([{ kind: 'markdownContent', content: new MarkdownString(localize('neoNoResponse', "_Provider returned no content._")) }]);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.logService.error('[neocode swarm] Anthropic CLI invocation failed:', err);
			progress([{ kind: 'markdownContent', content: new MarkdownString(`**NeoCode Anthropic CLI:** ${msg}`) }]);
		} finally {
			worker?.dispose();
		}
	}

	// ─── Utility worker factories ─────────────────────────────────────────────

	private async createCliExecWorker(): Promise<{ worker: IUtilityProcessWorkerHandle; service: INeocodeSwarmCliExecService }> {
		const module = await import('../../../services/utilityProcess/electron-browser/utilityProcessWorkerWorkbenchService.js');
		// eslint-disable-next-line local/code-no-dangerous-type-assertions
		const utilityProcessService = this.instantiationService.invokeFunction(
			(accessor: any) => accessor.get(module.IUtilityProcessWorkerWorkbenchService)
		) as IUtilityProcessWorkerServiceLike;

		const worker = await utilityProcessService.createWorker({
			moduleId: SWARM_CLI_EXEC_WORKER_MODULE_ID,
			type: 'swarmCliExec',
			name: 'NeoCode Swarm CLI Exec',
		});
		const service = ProxyChannel.toService<INeocodeSwarmCliExecService>(
			worker.client.getChannel(NEO_SWARM_CLI_EXEC_CHANNEL)
		);
		return { worker, service };
	}

	// ─── Response text extractors ─────────────────────────────────────────────

	/**
	 * Parses JSONL output from `codex exec --experimental-json`.
	 *
	 * The codex binary emits one ThreadEvent JSON object per line.
	 * We collect text from `item.completed` events whose item type is `agent_message`.
	 * Other interesting events (command_execution, file_change) are ignored for now
	 * since the progress messages are already shown during execution.
	 */
	private extractCodexCliText(raw: string): string {
		const trimmed = raw.trim();
		if (!trimmed) { return ''; }

		let agentText = '';
		for (const line of trimmed.split('\n')) {
			const l = line.trim();
			if (!l.startsWith('{')) { continue; }
			try {
				const event = JSON.parse(l) as {
					type?: string;
					item?: { type?: string; text?: string };
					message?: string;
				};

				if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) {
					// The final completed event carries the full response text.
					agentText = event.item.text;
				} else if (event.type === 'turn.failed' || event.type === 'error') {
					const errMsg = event.message ?? (event.item as { text?: string } | undefined)?.text ?? 'Unknown error';
					return `**Codex error:** ${errMsg}`;
				}
			} catch { }
		}

		return agentText;
	}

	private extractClaudeCliText(raw: string): string {
		const trimmed = raw.trim();
		if (!trimmed) { return ''; }

		// Try to parse as a single JSON object first (--output-format json).
		try {
			const parsed = JSON.parse(trimmed) as { result?: string; content?: Array<{ type?: string; text?: string }> };
			if (typeof parsed.result === 'string' && parsed.result.trim()) {
				return parsed.result.trim();
			}
			// Some versions output an assistant message object.
			if (Array.isArray(parsed.content)) {
				const texts = parsed.content.filter(c => c.type === 'text' && c.text).map(c => c.text!);
				if (texts.length > 0) { return texts.join('\n'); }
			}
		} catch { }

		// Handle JSONL (one JSON object per line) — take the last "result" entry.
		const lines = trimmed.split('\n').filter(l => l.trim().startsWith('{'));
		let lastResult = '';
		for (const line of lines) {
			try {
				const obj = JSON.parse(line.trim()) as { type?: string; result?: string; content?: Array<{ type?: string; text?: string }> };
				if (obj.type === 'result' && typeof obj.result === 'string') {
					lastResult = obj.result;
				} else if (obj.type === 'assistant' && Array.isArray(obj.content)) {
					const texts = obj.content.filter(c => c.type === 'text' && c.text).map(c => c.text!);
					if (texts.length > 0) { lastResult = texts.join('\n'); }
				}
			} catch { }
		}
		if (lastResult) { return lastResult; }

		return trimmed;
	}

	// ─── Programmatic orchestrator command ────────────────────────────────────

	private async executeOrchestrator(prompt: string, token: CancellationToken = CancellationToken.None): Promise<string> {
		const config = this.storageService.load();
		const providers = config.providers.filter(p => p.enabled);

		if (providers.length === 0) {
			throw new Error('No providers configured in NeoCode Swarm.');
		}

		const preferredForCmd = providers.find(p => p.id === config.orchestrator.providerId);
		const candidatesForCmd = preferredForCmd
			? [preferredForCmd, ...providers.filter(p => p.id !== preferredForCmd.id)]
			: providers;

		let provider = candidatesForCmd[0];
		let credential: INeocodeCredential | undefined;
		for (const candidate of candidatesForCmd) {
			const cred = await this.resolveCredential(candidate);
			if (cred && (cred.kind === 'bearer' || cred.kind === 'qwen-oauth')) {
				provider = candidate;
				credential = cred;
				break;
			}
		}

		if (!credential) {
			throw new Error('No adapter-compatible credential found. Add an API key or Gemini/Qwen OAuth provider.');
		}

		const rawToken = credential.kind === 'bearer' ? credential.token
			: credential.kind === 'qwen-oauth' ? credential.rawToken
			: undefined;
		const cmdExtraEnv = credential.kind === 'qwen-oauth' ? credential.envData.env : undefined;
		const providerConfig = buildProviderConfig(provider);
		const env = buildEnvFromProvider(provider, rawToken, cmdExtraEnv);

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
			toolExecutor: this.toolExecutor,
			systemPrompt: orchestratorSystemPrompt,
			maxToolCallRounds: 15,
		};

		if (!this.adapter) {
			this.adapter = this._register(this.instantiationService.createInstance(QwenRuntimeAdapter));
		}

		const stream = this.adapter.runTask(providerConfig, { env, maskedEnv: {} }, sdkOptions, token);

		let result = '';
		for await (const chunk of stream) {
			if (token.isCancellationRequested) { break; }
			if (chunk.type === 'content' && chunk.value) {
				result += chunk.value;
			} else if (chunk.type === 'error' && chunk.error) {
				throw new Error(chunk.error);
			}
		}

		return result;
	}

	// ─── Activity panel ───────────────────────────────────────────────────────

	private async openActivityPanel(): Promise<void> {
		try {
			if (!this.activityEditorInput || this.activityEditorInput.isDisposed()) {
				this.activityEditorInput = this._register(this.instantiationService.createInstance(NeocodeSwarmActivityEditorInput));
			}
			await this.editorService.openEditor(this.activityEditorInput, { pinned: false, revealIfOpened: true });
		} catch (err) {
			this.logService.warn('[neocode swarm] Could not open activity panel:', err);
		}
	}

	// ─── Capability system prompt ─────────────────────────────────────────────

	private async buildCapabilitySystemPrompt(config: INeocodeSwarmConfig): Promise<string> {
		const workspaceRoot = this.workspaceService.getWorkspace().folders[0]?.uri.fsPath ?? '';
		const parts: string[] = [buildCodeEditingSystemPrompt(workspaceRoot)];

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

		const skills = config.capabilities?.skills ?? [];
		if (skills.length > 0) {
			const lines = skills.map(s => {
				const path = s.instructionPath ? ` — load instructions with: read_file("${s.instructionPath}")` : '';
				return `- **${s.name}** (${s.type}): ${s.description ?? ''}${path}`;
			});
			parts.push(`## Available Skills\nUse read_file to load a skill's full instructions when relevant:\n${lines.join('\n')}`);
		}

		const commands = config.capabilities?.commands ?? [];
		if (commands.length > 0) {
			const lines = commands.map(c => `- /${c.name}: ${c.description ?? ''}`);
			parts.push(`## Custom Commands\n${lines.join('\n')}`);
		}

		return parts.join('\n\n');
	}

	private async resolvePersonalityRule(soulRule: string, sourcePath?: string): Promise<string | undefined> {
		if (!soulRule?.trim()) { return undefined; }

		const templateMatch = /^\{\{\s*(.+?)\s*\}\}$/.exec(soulRule.trim());
		const filePath = templateMatch?.[1] ?? sourcePath;

		if (filePath) {
			const content = await this.loadCapabilityFile(filePath);
			if (content) { return content; }
		}

		return soulRule;
	}

	private async loadCapabilityFile(relativePath: string): Promise<string | undefined> {
		try {
			const workspaceFolders = this.workspaceService.getWorkspace().folders;
			if (workspaceFolders.length === 0) { return undefined; }

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

	/**
	 * Returns the secret storage scope for a provider.
	 * Non-custom providers use their type string (e.g. 'gemini', 'openai') as scope,
	 * matching exactly how the settings editor persists credentials.
	 * Custom providers use their unique ID.
	 */
	private providerSecretScope(provider: INeocodeSwarmProviderConfig): string {
		return provider.type === 'custom' ? provider.id : provider.type;
	}

	/**
	 * Resolves how to authenticate a provider invocation.
	 *
	 * Returns a typed credential that tells the invocation path which mechanism to use:
	 * - `bearer`        → plain API key or Gemini OAuth token → QwenRuntimeAdapter
	 * - `qwen-oauth`    → Qwen Code session from IQwenAuthService → QwenRuntimeAdapter (qwen-oauth)
	 * - `codex-cli`     → OpenAI browser login token → `codex exec --experimental-json` subprocess
	 * - `anthropic-cli` → Anthropic CLI login → `claude` subprocess
	 */
	private async resolveCredential(provider: INeocodeSwarmProviderConfig): Promise<INeocodeCredential | undefined> {
		// ── Gemini: OAuth Bearer token from GeminiAuthService (auto-refresh) ──
		if (provider.type === 'gemini') {
			try {
				const runtimeEnv = await this.geminiAuthService.buildRuntimeEnv();
				const token = runtimeEnv.env['GEMINI_API_KEY'] ?? runtimeEnv.env['GOOGLE_API_KEY'];
				if (token?.trim()) { return { kind: 'bearer', token }; }
			} catch {
				// Fall through to API key lookup below
			}
		}

		// ── Qwen Code: OAuth session from IQwenAuthService ───────────────────
		if (provider.type === 'qwen-code' && provider.authMethod === 'qwen-oauth') {
			try {
				const envData = await this.qwenAuthService.buildRuntimeEnv();
				const qwenConfig = this.qwenAuthService.loadConfig();
				const rawToken = envData.env[qwenConfig.envVarName];
				if (rawToken?.trim()) { return { kind: 'qwen-oauth', rawToken, envData }; }
			} catch {
				// Fall through to API key lookup
			}
		}

		// ── OpenAI browser login: use `codex exec --experimental-json` ──────
		// The stored OAuth bundle's access_token is passed as OPENAI_API_KEY to
		// the codex binary. If no bundle is stored, the binary falls back to its
		// own ~/.codex/ credential store (set up via `codex login`).
		if (provider.type === 'openai' && provider.authMethod === 'login') {
			let accessToken: string | undefined;
			const scope = this.providerSecretScope(provider);
			for (const storageKey of [scope, provider.id]) {
				for (const kind of ['loginToken', 'apiKey'] as const) {
					const val = await this.secretService.getProviderSecret(storageKey, kind);
					if (!val?.trim()) { continue; }
					if (val.trim().startsWith('{')) {
						const bundle = parseStoredOpenAITokenBundle(val);
						if (bundle?.accessToken) {
							let resolved = bundle;
							if (isOpenAITokenExpiredOrNearExpiry(bundle)) {
								try { resolved = await refreshOpenAITokenBundle(bundle); } catch { /* use as-is */ }
							}
							accessToken = resolved.accessToken;
						}
					}
				}
			}
			// Return codex-cli even without a token — the binary may have its own session.
			return { kind: 'codex-cli', accessToken };
		}

		// ── Anthropic CLI login: `claude` subprocess (no stored credential needed) ──
		if (provider.type === 'anthropic' && (provider.authMethod === 'login' || provider.authMethod === 'cliToken')) {
			return { kind: 'anthropic-cli' };
		}

		// ── Plain API key (any provider) ──────────────────────────────────────
		const scope = this.providerSecretScope(provider);
		for (const kind of ['apiKey', 'loginToken', 'cliToken'] as const) {
			for (const storageKey of scope !== provider.id ? [scope, provider.id] : [scope]) {
				const val = await this.secretService.getProviderSecret(storageKey, kind);
				if (!val?.trim()) { continue; }
				if (val.trim().startsWith('{')) { continue; } // Skip JSON bundles (handled above)
				return { kind: 'bearer', token: val };
			}
		}

		return undefined;
	}

	private buildFileContext(request: IChatAgentRequest): string | undefined {
		const variables = request.variables?.variables;
		if (!variables || variables.length === 0) { return undefined; }

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

import * as DOM from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore, IReference } from '../../../../base/common/lifecycle.js';
import { IChannel, ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { URI } from '../../../../base/common/uri.js';
import { AppResourcePath, FileAccess } from '../../../../base/common/network.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IBoundarySashes } from '../../../../base/browser/ui/sash/sash.js';
import {
	createDefaultNeocodeSwarmConfig,
	INeocodeSwarmAgentConfig,
	INeocodeSwarmConfig,
	INeocodeSwarmProviderConfig,
	NeocodeSwarmAuthMethod,
	NeocodeSwarmProviderStatus,
	NeocodeSwarmProviderType,
	providerNeedsApiKey
} from '../common/neocodeSwarmTypes.js';
import { NeocodeSwarmProviderTest } from './neocodeSwarmProviderTest.js';
import {
	IOpenAITokenBundle,
	isOpenAITokenExpiredOrNearExpiry,
	NeocodeSwarmOpenAIOAuthController,
	parseStoredOpenAITokenBundle,
	refreshOpenAITokenBundle
} from './neocodeSwarmOpenAIOAuthController.js';
import { NeocodeSwarmSecretService } from './neocodeSwarmSecretService.js';
import { NeocodeSwarmStorageService } from './neocodeSwarmStorageService.js';
import { IQwenAuthService } from '../../neocode/qwen/common/qwenTypes.js';
import { IGeminiAuthService, NEO_GEMINI_COMMAND_OPEN_SETTINGS } from '../../neocode/gemini/common/geminiTypes.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { INeocodeSwarmCliExecOptions, INeocodeSwarmCliExecResult, INeocodeSwarmCliExecService, NEO_SWARM_CLI_EXEC_CHANNEL } from '../common/neocodeSwarmCliExecTypes.js';
import './media/neocodeSwarmSettingsEditor.css';

type SwarmTab = 'models' | 'orchestration' | 'agents' | 'capabilities' | 'security' | 'advanced';
type ProviderSecretKind = 'apiKey' | 'loginToken' | 'cliToken';

interface IProviderTestState {
	busy: boolean;
	ok?: boolean;
	message?: string;
}

const SWARM_CLI_EXEC_WORKER_MODULE_ID = 'vs/workbench/contrib/neocodeSwarm/node/neocodeSwarmCliExecMain';

interface IUtilityProcessWorkerHandle {
	client: { getChannel(channelName: string): IChannel };
	dispose(): void;
}

interface IUtilityProcessWorkerServiceLike {
	createWorker(process: { moduleId: string; type: string; name: string }): Promise<IUtilityProcessWorkerHandle>;
}

export class NeocodeSwarmSettingsEditorInput extends EditorInput {
	static readonly ID = 'workbench.input.neocodeSwarmSettings';

	override get typeId(): string {
		return NeocodeSwarmSettingsEditorInput.ID;
	}

	override getName(): string {
		return localize('neocodeSwarmSettings', "Configurar Enxame");
	}

	override getIcon(): ThemeIcon {
		return Codicon.hubot;
	}

	override readonly resource = URI.from({ scheme: 'neocode-swarm', path: 'settings' });

	override matches(other: EditorInput): boolean {
		return other instanceof NeocodeSwarmSettingsEditorInput;
	}
}

export class NeocodeSwarmSettingsEditor extends EditorPane {
	static readonly ID = 'workbench.editors.neocodeSwarmSettings';

	private readonly storage = this._register(this.instantiationService.createInstance(NeocodeSwarmStorageService));
	private readonly secrets = this._register(this.instantiationService.createInstance(NeocodeSwarmSecretService));
	private readonly providerTest = this.instantiationService.createInstance(NeocodeSwarmProviderTest);
	private readonly openAIOAuth = this._register(this.instantiationService.createInstance(NeocodeSwarmOpenAIOAuthController));

	private readonly tabDisposables = this._register(new DisposableStore());
	private config: INeocodeSwarmConfig = createDefaultNeocodeSwarmConfig();
	private activeTab: SwarmTab = 'models';
	private selectedProviderId: string | undefined;
	private contentContainer: HTMLElement | undefined;
	private tabButtons = new Map<SwarmTab, HTMLButtonElement>();
	private providerSecretDraft = new Map<string, string>();
	private providerSecretMasked = new Map<string, string>();
	private providerTestState = new Map<string, IProviderTestState>();
	private statusBar: HTMLElement | undefined;
	private toolbar: HTMLElement | undefined;
	private modelSearchTerm = '';
	private activeCapabilityTab: 'personalities' | 'skills' | 'hooks' | 'commands' = 'personalities';
	private expandedCapabilities = new Set<string>();

	constructor(
		group: IEditorGroup,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IDialogService private readonly dialogService: IDialogService,
		@IFileService private readonly fileService: IFileService,
		@INotificationService private readonly notificationService: INotificationService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IPathService private readonly pathService: IPathService,
		@IQwenAuthService private readonly qwenAuthService: IQwenAuthService,
		@IGeminiAuthService private readonly geminiAuthService: IGeminiAuthService,
		@ICommandService private readonly commandService: ICommandService
	) {
		super(NeocodeSwarmSettingsEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		const container = DOM.append(parent, DOM.$('.neocode-swarm-editor'));
		this.renderBody(container);
	}

	override layout(dimension: DOM.Dimension): void {
		const container = this.getContainer();
		if (container) {
			container.style.width = `${dimension.width} px`;
			container.style.height = `${dimension.height} px`;
		}
	}

	override setBoundarySashes(sashes: IBoundarySashes): void {
		// Subclasses can implement
	}

	override async setInput(input: NeocodeSwarmSettingsEditorInput, options: any, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.config = this.storage.load();
		this.selectedProviderId = this.config.providers[0]?.id;
		await this.refreshOpenAIProviderAuthState();
		await this.refreshSecretMasks();
		this.renderActiveTab();
		this.testAllProvidersInBackground();
	}

	private testAllProvidersInBackground(): void {
		let hasChanges = false;
		Promise.all(this.config.providers.map(async provider => {
			if (!provider.enabled) {
				return;
			}
			this.providerTestState.set(provider.id, { busy: true });
			this.renderActiveTab();

			try {
				let result: { ok: boolean; message: string };

				if (provider.type === 'gemini') {
					const geminiConfig = this.geminiAuthService.loadConfig();
					result = geminiConfig.authType === 'apiKey'
						? await this.geminiAuthService.testApiKeyConnection()
						: await this.geminiAuthService.testGoogleLoginConnection();
				} else if (provider.type === 'anthropic' && provider.authMethod === 'login') {
					result = await this.testAnthropicLoginConnection();
				} else if (provider.type === 'qwen-code' && provider.authMethod === 'qwen-oauth') {
					result = await this.qwenAuthService.testApiKeyConnection();
				} else {
					const secret = await this.getProviderSecretWithFallback(provider, provider.authMethod === 'apiKey' ? 'apiKey' : 'loginToken');
					result = await this.providerTest.testConnection(provider, secret ?? '');
				}

				this.providerTestState.set(provider.id, { busy: false, ok: result.ok, message: result.message });

				if (provider.status !== (result.ok ? 'connected' : 'error') || provider.statusMessage !== result.message) {
					provider.status = result.ok ? 'connected' : 'error';
					provider.statusMessage = result.message;
					hasChanges = true;
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.providerTestState.set(provider.id, { busy: false, ok: false, message });
				if (provider.status !== 'error' || provider.statusMessage !== message) {
					provider.status = 'error';
					provider.statusMessage = message;
					hasChanges = true;
				}
			} finally {
				this.renderActiveTab();
			}
		})).then(() => {
			if (hasChanges) {
				this.saveConfig(undefined, true);
			}
		}).catch(() => { /* ignore */ });
	}

	private async refreshOpenAIProviderAuthState(): Promise<void> {
		let hasChanges = false;
		for (const provider of this.config.providers) {
			if (provider.type !== 'openai') {
				continue;
			}
			const scope = this.providerSecretScope(provider);
			const saved = await this.getProviderSecretWithFallback(provider, 'loginToken');
			if (!saved?.trim()) {
				if (provider.status !== 'notConfigured' || provider.statusMessage) {
					provider.status = 'notConfigured';
					provider.statusMessage = localize('neoSwarm.openaiMissingToken', "Conta ChatGPT nao conectada.");
					hasChanges = true;
				}
				continue;
			}

			const parsed = parseStoredOpenAITokenBundle(saved);
			if (!parsed?.accessToken?.trim()) {
				provider.status = 'error';
				provider.statusMessage = localize('neoSwarm.openaiInvalidStoredToken', "Token salvo em formato invalido. Reconecte sua conta ChatGPT.");
				hasChanges = true;
				continue;
			}

			let effectiveToken = parsed;
			if (isOpenAITokenExpiredOrNearExpiry(effectiveToken)) {
				if (!effectiveToken.refreshToken?.trim()) {
					provider.status = 'error';
					provider.statusMessage = localize('neoSwarm.openaiExpiredNoRefresh', "Token expirado e sem refresh_token. Reconecte sua conta ChatGPT.");
					hasChanges = true;
					continue;
				}
				try {
					effectiveToken = await refreshOpenAITokenBundle(effectiveToken);
					await this.secrets.setProviderSecret(scope, 'loginToken', JSON.stringify(effectiveToken));
				} catch (error) {
					provider.status = 'error';
					provider.statusMessage = error instanceof Error
						? error.message
						: localize('neoSwarm.openaiRefreshFailed', "Falha ao atualizar token OAuth. Reconecte sua conta ChatGPT.");
					hasChanges = true;
					continue;
				}
			}

			const nextMessage = this.describeOpenAIToken(effectiveToken);
			if (provider.status !== 'connected' || provider.statusMessage !== nextMessage) {
				provider.status = 'connected';
				provider.statusMessage = nextMessage;
				hasChanges = true;
			}
		}

		if (hasChanges) {
			this.saveConfig(undefined, true);
		}
	}

	private async refreshSecretMasks(): Promise<void> {
		this.providerSecretMasked.clear();
		for (const provider of this.config.providers) {
			const scope = this.providerSecretScope(provider);
			if (await this.getProviderSecretWithFallback(provider, 'apiKey')) {
				this.providerSecretMasked.set(this.secretDraftKey(scope, 'apiKey'), '********');
			}
			if (await this.getProviderSecretWithFallback(provider, 'loginToken')) {
				this.providerSecretMasked.set(this.secretDraftKey(scope, 'loginToken'), '********');
			}
		}
	}

	private providerSecretScope(provider: INeocodeSwarmProviderConfig): string {
		return provider.type === 'custom' ? provider.id : provider.type;
	}

	private async getProviderSecretWithFallback(provider: INeocodeSwarmProviderConfig, kind: 'apiKey' | 'loginToken' | 'cliToken'): Promise<string | undefined> {
		const scope = this.providerSecretScope(provider);
		let secret = await this.secrets.getProviderSecret(scope, kind);
		if (secret?.trim() || scope === provider.id) {
			return secret;
		}

		secret = await this.secrets.getProviderSecret(provider.id, kind);
		if (secret?.trim()) {
			await this.secrets.setProviderSecret(scope, kind, secret);
			await this.secrets.setProviderSecret(provider.id, kind, '');
		}
		return secret;
	}

	private secretDraftKey(providerScope: string, kind: ProviderSecretKind): string {
		return `${providerScope}_${kind} `;
	}

	private renderBody(container: HTMLElement): void {
		const shell = DOM.append(container, DOM.$('.neocode-swarm-shell'));
		const nav = DOM.append(shell, DOM.$('.neocode-swarm-nav'));
		const main = DOM.append(shell, DOM.$('.neocode-swarm-main'));

		const navSearch = DOM.append(nav, DOM.$('input.neocode-input', {
			type: 'text',
			placeholder: localize('neoSwarm.modelSearchNav', "Buscar modelos")
		})) as HTMLInputElement;
		this._register(DOM.addDisposableListener(navSearch, DOM.EventType.INPUT, () => {
			this.modelSearchTerm = navSearch.value.trim().toLowerCase();
			if (this.activeTab === 'models') {
				this.renderActiveTab();
			}
		}));

		const navTabs = DOM.append(nav, DOM.$('.neocode-swarm-tabs', { role: 'tablist' }));
		this.tabButtons.set('models', this.createTabButton(navTabs, 'models', localize('neoSwarm.tab.models', "Modelos"), Codicon.database));
		this.tabButtons.set('orchestration', this.createTabButton(navTabs, 'orchestration', localize('neoSwarm.tab.orchestration', "Orquestracao"), Codicon.circuitBoard));
		this.tabButtons.set('agents', this.createTabButton(navTabs, 'agents', localize('neoSwarm.tab.agents', "Agentes"), Codicon.hubot));
		this.tabButtons.set('capabilities', this.createTabButton(navTabs, 'capabilities', localize('neoSwarm.tab.capabilities', "Capacidades"), Codicon.library));

		this.tabButtons.set('security', this.createTabButton(navTabs, 'security', localize('neoSwarm.tab.security', "Seguranca"), Codicon.shield));
		this.tabButtons.set('advanced', this.createTabButton(navTabs, 'advanced', localize('neoSwarm.tab.advanced', "Avancado"), Codicon.settingsGear));

		this.toolbar = DOM.append(main, DOM.$('.neocode-swarm-toolbar'));
		this.toolbar.style.display = 'none';

		this.contentContainer = DOM.append(main, DOM.$('.neocode-swarm-content'));
		this.statusBar = DOM.append(main, DOM.$('.neocode-swarm-status'));
	}

	private createTabButton(parent: HTMLElement, tab: SwarmTab, label: string, icon?: ThemeIcon): HTMLButtonElement {
		const button = DOM.append(parent, DOM.$('button.neocode-swarm-tab', { type: 'button', role: 'tab' })) as HTMLButtonElement;
		if (icon) {
			DOM.append(button, DOM.$(`span${ThemeIcon.asCSSSelector(icon)} `));
		}
		DOM.append(button, DOM.$('span.tab-label', undefined, label));
		this._register(DOM.addDisposableListener(button, DOM.EventType.CLICK, () => {
			this.activeTab = tab;
			this.renderActiveTab();
		}));
		return button;
	}

	private renderActiveTab(): void {
		if (!this.contentContainer) return;
		this.tabDisposables.clear();
		DOM.clearNode(this.contentContainer);
		if (this.toolbar) {
			DOM.clearNode(this.toolbar);
			this.toolbar.style.display = 'none';
		}
		for (const [tabId, button] of this.tabButtons.entries()) {
			button.classList.toggle('active', tabId === this.activeTab);
			button.setAttribute('aria-selected', tabId === this.activeTab ? 'true' : 'false');
		}

		switch (this.activeTab) {
			case 'models': this.renderModelsTab(this.contentContainer); break;
			case 'orchestration': this.renderOrchestrationTab(this.contentContainer); break;
			case 'agents': this.renderAgentsTab(this.contentContainer); break;
			case 'capabilities': this.renderCapabilitiesTab(this.contentContainer); break;

			case 'security': this.renderSecurityTab(this.contentContainer); break;
			case 'advanced': this.renderAdvancedTab(this.contentContainer); break;
		}
	}

	private renderModelsTab(container: HTMLElement): void {
		const layout = DOM.append(container, DOM.$('.neocode-swarm-two-column'));
		const listColumn = DOM.append(layout, DOM.$('.neocode-swarm-list-column'));
		const detailColumn = DOM.append(layout, DOM.$('.neocode-swarm-detail-column'));

		const listHeader = DOM.append(listColumn, DOM.$('.neocode-title-row'));
		DOM.append(listHeader, DOM.$('span', undefined, localize('neoSwarm.models', "Provedores")));
		DOM.append(listColumn, DOM.$('.neocode-note', undefined, localize('neoSwarm.modelsHelp', "Cada familia de provedor usa uma credencial unica para todos os modelos daquela familia.")));

		const filteredModels = this.config.providers.filter(model => {
			if (!this.modelSearchTerm) return true;
			return model.name.toLowerCase().includes(this.modelSearchTerm) || this.formatProviderType(model.type).toLowerCase().includes(this.modelSearchTerm);
		});

		for (const model of filteredModels) {
			const card = DOM.append(listColumn, DOM.$('.neocode-provider-card'));
			if (model.id === this.selectedProviderId) card.classList.add('selected');

			const title = DOM.append(card, DOM.$('.neocode-provider-card-title'));
			const iconClass = this.getProviderStatusIcon(model.id, model.status ?? 'notConfigured');
			DOM.append(title, DOM.$(`span.codicon.${iconClass} `));
			DOM.append(title, DOM.$('span', undefined, model.name));
			const enabledToggle = DOM.append(title, DOM.$('input', { type: 'checkbox' })) as HTMLInputElement;
			enabledToggle.checked = model.enabled;
			this.tabDisposables.add(DOM.addDisposableListener(enabledToggle, DOM.EventType.CHANGE, e => {
				e.stopPropagation();
				model.enabled = enabledToggle.checked;
				this.saveConfig(undefined, true);
			}));

			DOM.append(card, DOM.$('.neocode-provider-card-subtitle', undefined, `${this.formatProviderType(model.type)} · ${this.formatAuthMethod(model.authMethod)} `));
			const actions = DOM.append(card, DOM.$('.neocode-provider-card-actions'));
			this.appendButton(actions, localize('neoSwarm.modelTest', "Testar"), () => this.handleProviderTest(model));

			this.tabDisposables.add(DOM.addDisposableListener(card, DOM.EventType.CLICK, () => {
				this.selectedProviderId = model.id;
				this.renderActiveTab();
			}));
		}

		if (filteredModels.length === 0) {
			DOM.append(listColumn, DOM.$('.neocode-placeholder', undefined, localize('neoSwarm.noModelSearchResult', "Nenhum modelo corresponde a busca.")));
		}

		const selectedModel = this.config.providers.find(model => model.id === this.selectedProviderId) ?? filteredModels[0];
		if (!selectedModel) {
			DOM.append(detailColumn, DOM.$('.neocode-placeholder', undefined, localize('neoSwarm.noProvider', "Selecione um modelo para configurar.")));
			return;
		}
		this.selectedProviderId = selectedModel.id;
		this.renderModelEditor(detailColumn, selectedModel);
	}

	private renderModelEditor(container: HTMLElement, model: INeocodeSwarmProviderConfig): void {
		DOM.append(container, DOM.$('h3', undefined, model.name));
		const form = DOM.append(container, DOM.$('.neocode-form-grid'));
		this.appendLabeledInput(form, localize('neoSwarm.modelName', "Nome da familia"), model.name, value => model.name = value);
		this.appendSelect(form, localize('neoSwarm.modelType', "Familia"), model.type, [
			{ value: 'gemini', label: 'Gemini' },
			{ value: 'openai', label: 'OpenAI' },
			{ value: 'anthropic', label: 'Anthropic' },
			{ value: 'qwen-code', label: 'Qwen Code' },
			{ value: 'custom', label: 'Personalizado' }
		], value => {
			model.type = value as NeocodeSwarmProviderType;
			this.renderActiveTab();
		});
		if (this.config.advanced.isDeveloperMode) {
			const labelWithIcon = DOM.$('span');
			DOM.append(labelWithIcon, DOM.$(`span${ThemeIcon.asCSSSelector(Codicon.code)} `, { style: 'margin-right: 4px; vertical-align: middle;' }));
			DOM.append(labelWithIcon, DOM.$('span', undefined, localize('neoSwarm.availableModels', "Modelos disponiveis (um por linha)")));

			this.appendLabeledTextArea(form, labelWithIcon, (model.models ?? []).join('\n'), value => {
				model.models = value.split('\n').map(m => m.trim()).filter(m => !!m);
			});
		}
		this.appendSelect(form, localize('neoSwarm.selectedModel', "Modelo Ativo (Dropdown)"), model.selectedModel ?? '', model.models.map(m => ({ value: m, label: `✨ ${m} ` })), value => {
			model.selectedModel = value;
			if (this.config.orchestrator.providerId === model.id) {
				this.config.orchestrator.model = value || undefined;
			}
		});
		this.appendSelect(form, localize('neoSwarm.authMethod', "Metodo de Autenticacao"), model.authMethod, this.providerAuthOptions(model.type), value => {
			model.authMethod = value as NeocodeSwarmAuthMethod;
			if (model.type === 'qwen-code') {
				if (model.authMethod === 'qwen-oauth') {
					void this.qwenAuthService.saveOAuthSelection({ protocol: 'openai' });
				} else if (model.authMethod === 'apiKey') {
					// We don't have the key here, but we can set the type
					void this.qwenAuthService.saveApiKeyConfig({ protocol: 'openai', apiKey: '' });
				}
			}
			this.renderActiveTab();
		});
		this.appendLabeledInput(form, localize('neoSwarm.baseUrl', "URL base (opcional)"), model.baseUrl ?? '', value => model.baseUrl = value || undefined);
		this.appendLabeledTextArea(form, localize('neoSwarm.modelSoulRule', "Regra de alma / comportamento"), model.soulRule ?? '', value => model.soulRule = value || undefined);

		const statusMessage = model.statusMessage ?? this.formatProviderStatus(model.status ?? 'notConfigured');
		DOM.append(container, DOM.$('.neocode-inline-status', undefined, `${localize('neoSwarm.status', "Status")}: ${statusMessage} `));
		const authContainer = DOM.append(container, DOM.$('.neocode-provider-auth-block'));
		if (model.authMethod === 'apiKey' && providerNeedsApiKey(model)) {
			this.renderModelApiKeyAuth(authContainer, model);
		} else if (model.authMethod === 'login' || model.authMethod === 'qwen-oauth') {
			this.renderModelLoginAuth(authContainer, model);
		} else {
			this.renderModelCliAuth(authContainer, model);
		}

		const actions = DOM.append(container, DOM.$('.neocode-actions-row'));
		const saveButton = this.appendButton(actions, localize('neoSwarm.modelSave', "Salvar modelo"), () => {
			model.name = model.name.trim() || this.formatProviderType(model.type);
			this.saveConfig(localize('neoSwarm.modelSaved', "Modelo salvo."));
			this.renderActiveTab();
		});
		saveButton.classList.add('primary');
		this.appendButton(actions, localize('neoSwarm.providerTestConnection', "Testar conexao"), () => this.handleProviderTest(model));
	}

	private renderModelApiKeyAuth(container: HTMLElement, model: INeocodeSwarmProviderConfig): void {
		DOM.append(container, DOM.$('.neocode-note', undefined, localize('neoSwarm.apiKeyNote', "A API key fica salva no cofre seguro do sistema e nunca no JSON de configuracoes.")));
		const scope = this.providerSecretScope(model);
		const key = this.secretDraftKey(scope, 'apiKey');
		const inputRow = DOM.append(container, DOM.$('.neocode-inline-field-row'));
		const input = DOM.append(inputRow, DOM.$('input.neocode-input', {
			type: 'password',
			placeholder: this.providerSecretMasked.get(key) ?? 'sk-***...***'
		})) as HTMLInputElement;
		input.value = this.providerSecretDraft.get(key) ?? '';
		this.tabDisposables.add(DOM.addDisposableListener(input, DOM.EventType.INPUT, () => this.providerSecretDraft.set(key, input.value)));
		this.appendButton(inputRow, localize('neoSwarm.toggleSecret', "Mostrar/Ocultar"), () => {
			input.type = input.type === 'password' ? 'text' : 'password';
		});
		this.appendButton(container, localize('neoSwarm.apiKeySave', "Salvar API key"), async () => {
			const value = input.value.trim();
			if (!value) {
				this.updateStatus(localize('neoSwarm.apiKeyRequired', "API key nao pode ficar vazia."), true);
				return;
			}
			await this.secrets.setProviderSecret(scope, 'apiKey', value);
			this.providerSecretDraft.delete(key);
			await this.refreshSecretMasks();
			model.status = 'notConfigured';
			model.statusMessage = localize('neoSwarm.apiKeyStored', "API key salva com seguranca.");
			this.saveConfig(localize('neoSwarm.apiKeyStored', "API key salva com seguranca."), true);
			this.renderActiveTab();
		});
	}

	private renderModelLoginAuth(container: HTMLElement, model: INeocodeSwarmProviderConfig): void {
		if (model.type === 'openai') {
			this.renderOpenAILoginAuth(container, model);
			return;
		}
		if (model.type === 'anthropic') {
			this.renderAnthropicLoginAuth(container, model);
			return;
		}
		if (model.type === 'qwen-code') {
			this.renderQwenOAuthAuth(container, model);
			return;
		}
		if (model.type === 'gemini') {
			this.renderGeminiAuth(container, model);
			return;
		}

		DOM.append(container, DOM.$('.neocode-note', undefined, localize('neoSwarm.loginNote', "Use login por navegador/device e depois cole o token gerado. A credencial sera compartilhada por toda a familia.")));
		this.appendButton(container, localize('neoSwarm.connectWithProvider', "Conectar com {0}", model.name), () => { void this.startLoginFlow(model); });
		const scope = this.providerSecretScope(model);
		const key = this.secretDraftKey(scope, 'loginToken');
		const tokenInput = DOM.append(container, DOM.$('input.neocode-input', {
			type: 'password',
			placeholder: this.providerSecretMasked.get(key) ?? localize('neoSwarm.loginTokenPlaceholder', "Cole o token de login")
		})) as HTMLInputElement;
		tokenInput.value = this.providerSecretDraft.get(key) ?? '';
		this.tabDisposables.add(DOM.addDisposableListener(tokenInput, DOM.EventType.INPUT, () => this.providerSecretDraft.set(key, tokenInput.value)));
		const actions = DOM.append(container, DOM.$('.neocode-actions-row'));
		this.appendButton(actions, localize('neoSwarm.loginSave', "Salvar login token"), async () => {
			const value = tokenInput.value.trim();
			if (!value) {
				this.updateStatus(localize('neoSwarm.loginTokenMissing', "Token de login nao pode ficar vazio."), true);
				return;
			}
			await this.secrets.setProviderSecret(scope, 'loginToken', value);
			this.providerSecretDraft.delete(key);
			await this.refreshSecretMasks();
			model.status = 'connected';
			model.statusMessage = localize('neoSwarm.loginConnected', "Token de login salvo.");
			this.saveConfig(localize('neoSwarm.loginConnected', "Token de login salvo."), true);
			this.renderActiveTab();
		});
		this.appendButton(actions, localize('neoSwarm.disconnectProvider', "Desconectar"), async () => {
			await this.secrets.setProviderSecret(scope, 'loginToken', '');
			if (scope !== model.id) {
				await this.secrets.setProviderSecret(model.id, 'loginToken', '');
			}
			await this.refreshSecretMasks();
			model.status = 'notConfigured';
			model.statusMessage = localize('neoSwarm.loginDisconnected', "Token de login removido.");
			this.saveConfig(localize('neoSwarm.loginDisconnected', "Token de login removido."), true);
			this.renderActiveTab();
		});
	}

	private renderAnthropicLoginAuth(container: HTMLElement, model: INeocodeSwarmProviderConfig): void {
		DOM.append(container, DOM.$('.neocode-note', undefined, localize(
			'neoSwarm.anthropicLoginNote',
			"Anthropic Login usa o Claude CLI (login por navegador). Se o callback localhost falhar, copie apenas o parametro code da URL e cole no prompt do terminal do Claude."
		)));

		const status = DOM.append(container, DOM.$('.neocode-inline-status'));
		const actions = DOM.append(container, DOM.$('.neocode-actions-row'));

		const connectButton = this.appendButton(actions, localize('neoSwarm.anthropicConnect', "Iniciar Login Nativo"), async () => {
			await this.handleAnthropicLogin(model);
		});
		connectButton.classList.add('primary');

		this.appendButton(actions, localize('neoSwarm.anthropicCheckSession', "Verificar Sessao"), async () => {
			const result = await this.testAnthropicLoginConnection();
			model.status = result.ok ? 'connected' : 'error';
			model.statusMessage = result.message;
			this.saveConfig(undefined, true);
			this.renderActiveTab();
			this.updateStatus(result.message, !result.ok);
		});

		this.appendButton(actions, localize('neoSwarm.anthropicLogout', "Deslogar"), async () => {
			await this.handleAnthropicLogout(model);
		});

		this.appendButton(actions, localize('neoSwarm.anthropicSetupToken', "Gerar Token Longo (CLI)"), async () => {
			const cliPath = this.resolveAnthropicCliPath();
			const run = await this.runCliExec(cliPath, ['setup-token'], 10 * 60 * 1000);
			if (run.exitCode === 0) {
				this.updateStatus(localize('neoSwarm.anthropicSetupTokenDone', "Fluxo setup-token iniciado/concluido via Claude CLI. Se solicitado, finalize no terminal."));
			} else {
				const detail = [run.stderr, run.stdout].filter(Boolean).join('\n').trim();
				this.updateStatus(
					detail
						? localize('neoSwarm.anthropicSetupTokenFailedDetail', "Falha no setup-token: {0}", detail)
						: localize('neoSwarm.anthropicSetupTokenFailed', "Falha ao executar setup-token."),
					true
				);
			}
		});

		const lastStatus = model.status ?? 'notConfigured';
		const statusText = model.statusMessage ?? this.formatProviderStatus(lastStatus);
		status.textContent = `${lastStatus === 'connected' ? '✅' : lastStatus === 'error' ? '❌' : '⏳'} ${statusText} `;
	}

	/** Dedicated authentication panel for Qwen Code — uses the real CLI OAuth flow. */
	private renderQwenOAuthAuth(container: HTMLElement, model: INeocodeSwarmProviderConfig): void {
		const qwenConfig = this.qwenAuthService.loadConfig();
		const state = this.providerTestState.get(model.id);

		const lastStatus = state?.ok !== undefined ? (state.ok ? 'connected' : 'error') : (qwenConfig.lastConnectionStatus ?? 'unknown');
		const lastMessage = state?.message ?? (qwenConfig.lastConnectionMessage ?? localize('neoSwarm.qwenStatusUnknown', "Nao testado."));
		const isBusy = state?.busy ?? false;

		// Status display
		const statusIcon = isBusy ? '⏳' : (lastStatus === 'connected' ? '✅' : lastStatus === 'error' ? '❌' : '⏳');
		DOM.append(container, DOM.$('.neocode-note', undefined, localize(
			'neoSwarm.qwenOAuthNote',
			"Qwen OAuth usa o fluxo integrado. Clicando em Iniciar, uma aba no navegador será aberta para autorização. Suas credenciais serão mantidas localmente em ~/.qwen/."
		)));
		DOM.append(container, DOM.$('.neocode-inline-status', undefined, `${statusIcon} ${lastMessage} `));

		// Actions
		const actions = DOM.append(container, DOM.$('.neocode-actions-row'));

		// Start OAuth flow button — natively executed
		const oauthButton = this.appendButton(actions, localize('neoSwarm.qwenStartOAuthNative', "Iniciar Login Nativo"), async () => {
			this.updateStatus(localize('neoSwarm.qwenOAuthStartingNative', "Iniciando fluxo OAuth integrado..."));
			const result = await this.qwenAuthService.startNativeOAuthFlow((msg: string) => {
				this.updateStatus(msg);
			});
			model.status = result.ok ? 'connected' : 'error';
			model.statusMessage = result.message;
			this.saveConfig(undefined, true);
			this.renderActiveTab();
			this.updateStatus(result.message, !result.ok);
		});
		oauthButton.classList.add('primary');

		// Test connection button
		this.appendButton(actions, localize('neoSwarm.qwenTestConnection', "Testar Conexao"), async () => {
			this.updateStatus(localize('neoSwarm.qwenTesting', "Testando conexao com Qwen..."));
			const result = await this.qwenAuthService.testApiKeyConnection();
			model.status = result.ok ? 'connected' : 'error';
			model.statusMessage = result.message;
			this.saveConfig(undefined, true);
			this.renderActiveTab();
			this.updateStatus(result.message, !result.ok);
		});

		// Diagnostics button
		this.appendButton(actions, localize('neoSwarm.qwenDiagnostics', "Diagnostico"), async () => {
			const diag = await this.qwenAuthService.getDiagnostics();
			const lines: string[] = [
				`Auth: ${diag.authType} `,
				`Protocol: ${diag.protocol} `,
				`Model: ${diag.modelId} `,
				`CLI: ${diag.cliDetected ? `${diag.cliPath} (${diag.cliVersion ?? '?'})` : 'nao encontrado'} `,
				`Broken Auth State: ${diag.hasBrokenAuthState ? 'SIM' : 'nao'} `,
			];
			if (diag.issues.length > 0) {
				lines.push('', '--- Problemas ---', ...diag.issues);
			}
			if (diag.suggestions.length > 0) {
				lines.push('', '--- Sugestoes ---', ...diag.suggestions);
			}
			await this.dialogService.info(
				localize('neoSwarm.qwenDiagTitle', "Diagnostico Qwen Code"),
				lines.join('\n')
			);
		});

		// Reset broken auth state
		const resetRow = DOM.append(container, DOM.$('.neocode-actions-row'));
		this.appendButton(resetRow, localize('neoSwarm.qwenResetAuth', "Resetar estado de auth"), async () => {
			await this.qwenAuthService.resetBrokenAuthState();
			model.status = 'notConfigured';
			model.statusMessage = localize('neoSwarm.qwenAuthReset', "Estado de autenticacao resetado.");
			this.saveConfig(undefined, true);
			this.renderActiveTab();
			this.updateStatus(localize('neoSwarm.qwenAuthReset', "Estado de autenticacao resetado."));
		});
		this.appendButton(resetRow, localize('neoSwarm.qwenClearCredentials', "Limpar credenciais"), async () => {
			await this.qwenAuthService.clearAllQwenCredentials();
			model.status = 'notConfigured';
			model.statusMessage = localize('neoSwarm.qwenCredentialsCleared', "Credenciais Qwen removidas.");
			this.saveConfig(undefined, true);
			this.renderActiveTab();
			this.updateStatus(localize('neoSwarm.qwenCredentialsCleared', "Credenciais Qwen removidas."));
		});
	}

	/** Dedicated authentication status panel for Gemini — delegates to GeminiAuthService. */
	private renderGeminiAuth(container: HTMLElement, model: INeocodeSwarmProviderConfig): void {
		const geminiConfig = this.geminiAuthService.loadConfig();
		const state = this.providerTestState.get(model.id);

		const lastStatus = state?.ok !== undefined ? (state.ok ? 'connected' : 'error') : (geminiConfig.lastConnectionStatus ?? 'unknown');
		const lastMessage = state?.message ?? (geminiConfig.lastConnectionMessage ?? localize('neoSwarm.geminiStatusUnknown', 'Nao testado.'));
		const isBusy = state?.busy ?? false;

		const methodLabel = geminiConfig.authType === 'apiKey'
			? localize('neoSwarm.geminiMethodApiKey', 'API Key')
			: localize('neoSwarm.geminiMethodGoogleLogin', 'Login com Google');

		const statusIcon = isBusy ? '⏳' : (lastStatus === 'connected' ? '✅' : lastStatus === 'error' ? '❌' : '⏳');
		DOM.append(container, DOM.$('.neocode-note', undefined, localize(
			'neoSwarm.geminiNote',
			'Gemini usa autenticacao dedicada. Metodo atual: {0}. Abra as configuracoes completas para mudar o metodo, chaves e diagnosticos.',
			methodLabel
		)));
		DOM.append(container, DOM.$('.neocode-inline-status', undefined, `${statusIcon} ${lastMessage} `));

		const actions = DOM.append(container, DOM.$('.neocode-actions-row'));

		const openSettingsBtn = this.appendButton(
			actions,
			localize('neoSwarm.openGeminiSettings', 'Configurar Gemini...'),
			() => { void this.commandService.executeCommand(NEO_GEMINI_COMMAND_OPEN_SETTINGS); }
		);
		openSettingsBtn.classList.add('primary');

		this.appendButton(actions, localize('neoSwarm.geminiTestConnection', 'Testar Conexao'), async () => {
			this.updateStatus(localize('neoSwarm.geminiTesting', 'Testando conexao com Gemini...'));
			const result = geminiConfig.authType === 'apiKey'
				? await this.geminiAuthService.testApiKeyConnection()
				: await this.geminiAuthService.testGoogleLoginConnection();
			model.status = result.ok ? 'connected' : 'error';
			model.statusMessage = result.message;
			this.saveConfig(undefined, true);
			this.renderActiveTab();
			this.updateStatus(result.message, !result.ok);
		});
	}

	private renderOpenAILoginAuth(container: HTMLElement, model: INeocodeSwarmProviderConfig): void {
		DOM.append(container, DOM.$('.neocode-note', undefined, localize('neoSwarm.openaiLoginNote', "Conecte sua conta ChatGPT para usar os modelos OpenAI no enxame. O callback eh processado automaticamente; se falhar, cole a URL/codigo manualmente.")));
		const actions = DOM.append(container, DOM.$('.neocode-actions-row'));
		const isConnected = model.status === 'connected';
		if (!isConnected) {
			const connectButton = this.appendButton(actions, localize('neoSwarm.openaiConnect', "Conectar com ChatGPT"), async () => {
				await this.handleOpenAIConnect(model);
			});
			connectButton.classList.add('primary');
		} else {
			this.appendButton(actions, localize('neoSwarm.openaiReconnect', "Renovar conexao"), async () => {
				await this.handleOpenAIConnect(model);
			});
		}
		this.appendButton(actions, localize('neoSwarm.disconnectProvider', "Desconectar"), async () => {
			const scope = this.providerSecretScope(model);
			await this.secrets.setProviderSecret(scope, 'loginToken', '');
			if (scope !== model.id) {
				await this.secrets.setProviderSecret(model.id, 'loginToken', '');
			}
			await this.refreshSecretMasks();
			model.status = 'notConfigured';
			model.statusMessage = localize('neoSwarm.loginDisconnected', "Token de login removido.");
			this.saveConfig(localize('neoSwarm.loginDisconnected', "Token de login removido."), true);
			this.renderActiveTab();
		});
	}

	private async handleOpenAIConnect(model: INeocodeSwarmProviderConfig): Promise<void> {
		const scope = this.providerSecretScope(model);
		try {
			this.updateStatus(localize('neoSwarm.openaiConnecting', "Abrindo login do ChatGPT..."));
			const token = await this.openAIOAuth.signInWithChatGPT();
			const hasScopeWarning = (token.missingScopes?.length ?? 0) > 0;
			const successMessage = hasScopeWarning
				? localize('neoSwarm.openaiConnectedWithScopeWarning', "Conta ChatGPT conectada, mas faltam scopes ({0}). Algumas chamadas podem falhar. Refaca o login.", token.missingScopes!.join(', '))
				: localize('neoSwarm.openaiConnected', "Conta ChatGPT conectada com sucesso.");
			await this.secrets.setProviderSecret(scope, 'loginToken', JSON.stringify(token));
			await this.refreshSecretMasks();
			model.status = 'connected';
			model.statusMessage = this.describeOpenAIToken(token);
			this.saveConfig(successMessage, true);
			this.renderActiveTab();
			this.updateStatus(successMessage, hasScopeWarning);
		} catch (error) {
			const message = error instanceof Error ? error.message : localize('neoSwarm.openaiConnectFailed', "Falha ao conectar conta ChatGPT.");
			model.status = 'error';
			model.statusMessage = message;
			this.saveConfig(undefined, true);
			this.renderActiveTab();
			this.updateStatus(message, true);
		}
	}

	private describeOpenAIToken(token: IOpenAITokenBundle): string {
		if (token.missingScopes?.length) {
			return localize(
				'neoSwarm.openaiTokenStoredMissingScopes',
				"Token OAuth salvo com aviso. Faltam scopes: {0}. Refaca o login.",
				token.missingScopes.join(', ')
			);
		}
		if (!token.expiresAt) {
			return localize('neoSwarm.openaiTokenStored', "Token OAuth salvo com seguranca.");
		}
		return localize('neoSwarm.openaiTokenStoredWithExpiry', "Token OAuth salvo com seguranca. Expira em {0}.", new Date(token.expiresAt).toLocaleString());
	}

	private renderModelCliAuth(container: HTMLElement, model: INeocodeSwarmProviderConfig): void {
		DOM.append(container, DOM.$('.neocode-note', undefined, localize('neoSwarm.cliAuthMessage', "Este modelo usa autenticacao via CLI local.")));
		const row = DOM.append(container, DOM.$('.neocode-checkbox-row'));
		const checkbox = DOM.append(row, DOM.$('input', { type: 'checkbox' })) as HTMLInputElement;
		checkbox.checked = model.cliAuthEnabled ?? true;
		this.tabDisposables.add(DOM.addDisposableListener(checkbox, DOM.EventType.CHANGE, () => {
			model.cliAuthEnabled = checkbox.checked;
			model.status = checkbox.checked ? 'connected' : 'notConfigured';
			model.statusMessage = checkbox.checked ? localize('neoSwarm.cliAuthEnabled', "Autenticacao por CLI habilitada.") : localize('neoSwarm.cliAuthDisabled', "Autenticacao por CLI desabilitada.");
			this.saveConfig(undefined, true);
		}));
		DOM.append(row, DOM.$('label', undefined, localize('neoSwarm.cliAuthCheckbox', "Usar autenticacao por CLI")));
	}

	private renderOrchestrationTab(container: HTMLElement): void {
		DOM.append(container, DOM.$('h3', undefined, localize('neoSwarm.orchestrationTitle', "Regras de orquestracao")));
		const form = DOM.append(container, DOM.$('.neocode-form-grid'));
		this.appendToggle(form, localize('neoSwarm.enableSwarm', "Ativar enxame"), this.config.swarmEnabled, value => this.config.swarmEnabled = value);
		this.appendSelect(form, localize('neoSwarm.orchestratorProvider', "Provedor do orquestrador"), this.config.orchestrator.providerId ?? '', this.enabledModelOptions(), value => {
			this.config.orchestrator.providerId = value || undefined;
			const provider = this.config.providers.find(p => p.id === value);
			this.config.orchestrator.model = provider?.selectedModel ?? provider?.models[0] ?? undefined;
			this.renderActiveTab();
		});
		this.appendSelect(form, localize('neoSwarm.orchestratorModel', "Modelo do orquestrador"), this.config.orchestrator.model ?? '', this.orchestratorModelOptions(), value => this.config.orchestrator.model = value || undefined);
		this.appendRange(form, localize('neoSwarm.temperature', "Temperatura"), this.config.orchestrator.temperature ?? 0.2, 0, 2, 0.1, value => this.config.orchestrator.temperature = value);
		this.appendRange(form, localize('neoSwarm.topP', "Top P"), this.config.orchestrator.topP ?? 0.9, 0, 1, 0.05, value => this.config.orchestrator.topP = value);
		this.appendRange(form, localize('neoSwarm.frequencyPenalty', "Penalidade de Frequencia"), this.config.orchestrator.frequencyPenalty ?? 0, -2, 2, 0.1, value => this.config.orchestrator.frequencyPenalty = value);
		this.appendRange(form, localize('neoSwarm.presencePenalty', "Penalidade de Presenca"), this.config.orchestrator.presencePenalty ?? 0, -2, 2, 0.1, value => this.config.orchestrator.presencePenalty = value);
		this.appendLabeledInput(form, localize('neoSwarm.maxTokens', "Max Tokens"), String(this.config.orchestrator.maxTokens ?? 4096), value => this.config.orchestrator.maxTokens = parseInt(value) || 4096);
		this.appendLabeledTextArea(form, localize('neoSwarm.orchestratorRule', "Regra de sistema do orquestrador"), this.config.orchestrator.systemRule ?? '', value => this.config.orchestrator.systemRule = value || undefined);

		const actions = DOM.append(container, DOM.$('.neocode-actions-row'));
		this.appendButton(actions, localize('neoSwarm.saveOrchestration', "Salvar orquestracao"), () => this.saveConfig(localize('neoSwarm.orchestrationSaved', "Regras de orquestracao salvas.")), true);
	}

	private renderAgentsTab(container: HTMLElement): void {
		const header = DOM.append(container, DOM.$('.neocode-title-row'));
		DOM.append(header, DOM.$('h3', undefined, localize('neoSwarm.agentsTitle', "Agentes de trabalho")));
		this.appendButton(header, localize('neoSwarm.addAgent', "Novo Agente"), () => {
			this.config.agents.push({
				id: generateUuid(),
				name: localize('neoSwarm.newAgent', "Novo Agente"),
				role: 'custom',
				providerId: this.config.orchestrator.providerId,
				mode: 'parallel',
				maxSteps: 8,
				maxTokens: 8192,
				timeoutSeconds: 180,
				active: true,
				soulRule: '',
				skills: []
			});
			this.renderActiveTab();
		});

		this.config.agents.forEach((agent, index) => this.renderAgentRow(container, agent, index));
	}

	private renderAgentRow(container: HTMLElement, agent: INeocodeSwarmAgentConfig, index: number): void {
		const card = DOM.append(container, DOM.$('.neocode-agent-card'));

		// Header Row
		const header = DOM.append(card, DOM.$('.neocode-agent-card-header'));
		const titleInfo = DOM.append(header, DOM.$('.neocode-agent-title-info'));
		DOM.append(titleInfo, DOM.$('span.codicon.codicon-account'));
		const nameInput = DOM.append(titleInfo, DOM.$('input.neocode-agent-name-input', { type: 'text', value: agent.name })) as HTMLInputElement;
		this.tabDisposables.add(DOM.addDisposableListener(nameInput, DOM.EventType.CHANGE, () => agent.name = nameInput.value));

		const headerActions = DOM.append(header, DOM.$('.neocode-agent-header-actions'));
		const activeToggle = DOM.append(headerActions, DOM.$('input', { type: 'checkbox' })) as HTMLInputElement;
		activeToggle.checked = agent.active;
		this.tabDisposables.add(DOM.addDisposableListener(activeToggle, DOM.EventType.CHANGE, () => agent.active = activeToggle.checked));
		DOM.append(headerActions, DOM.$('label', undefined, localize('neoSwarm.active', "Ativo")));
		this.appendButton(headerActions, localize('neoSwarm.up', "Subir"), () => {
			if (index <= 0) {
				return;
			}
			const previous = this.config.agents[index - 1];
			this.config.agents[index - 1] = this.config.agents[index];
			this.config.agents[index] = previous;
			this.renderActiveTab();
		});
		this.appendButton(headerActions, localize('neoSwarm.down', "Descer"), () => {
			if (index >= this.config.agents.length - 1) {
				return;
			}
			const next = this.config.agents[index + 1];
			this.config.agents[index + 1] = this.config.agents[index];
			this.config.agents[index] = next;
			this.renderActiveTab();
		});

		this.appendButton(headerActions, localize('neoSwarm.remove', "Remover"), () => {
			this.config.agents = this.config.agents.filter(candidate => candidate.id !== agent.id);
			this.renderActiveTab();
		}).classList.add('danger');

		// Content Grid
		const content = DOM.append(card, DOM.$('.neocode-agent-card-content'));

		// Left: Core Params
		const params = DOM.append(content, DOM.$('.neocode-agent-params'));
		this.appendSelect(params, localize('neoSwarm.agentRole', "Papel"), agent.role, [
			{ value: 'planner', label: localize('neoSwarm.rolePlanner', "Planejador") },
			{ value: 'coder', label: localize('neoSwarm.roleCoder', "Codificador") },
			{ value: 'reviewer', label: localize('neoSwarm.roleReviewer', "Revisor") },
			{ value: 'researcher', label: localize('neoSwarm.roleResearcher', "Pesquisador") },
			{ value: 'debugger', label: localize('neoSwarm.roleDebugger', "Depurador") },
			{ value: 'custom', label: localize('neoSwarm.roleCustom', "Personalizado") }
		], value => agent.role = value as INeocodeSwarmAgentConfig['role']);
		this.appendSelect(params, localize('neoSwarm.agentMode', "Modo"), agent.mode, [
			{ value: 'parallel', label: localize('neoSwarm.modeParallel', "Paralelo") },
			{ value: 'serial', label: localize('neoSwarm.modeSerial', "Serial") }
		], value => agent.mode = value as INeocodeSwarmAgentConfig['mode']);
		this.appendSelect(params, localize('neoSwarm.agentModel', "Modelo"), agent.providerId ?? '', this.enabledModelOptions(), value => agent.providerId = value || undefined);
		this.appendLabeledInput(params, localize('neoSwarm.maxSteps', "Passos Max"), String(agent.maxSteps), value => agent.maxSteps = parseInt(value) || 8);
		this.appendLabeledInput(params, localize('neoSwarm.maxTokens', "Tokens Max"), String(agent.maxTokens), value => agent.maxTokens = parseInt(value) || 8192);
		this.appendLabeledInput(params, localize('neoSwarm.timeoutSeconds', "Timeout (s)"), String(agent.timeoutSeconds), value => agent.timeoutSeconds = parseInt(value) || 180);

		// Right: Soul Rule
		const personality = DOM.append(content, DOM.$('.neocode-agent-personality'));
		this.appendLabeledTextArea(personality, localize('neoSwarm.soulRule', "Personalidade / Regras de Alma"), agent.soulRule ?? '', value => agent.soulRule = value || undefined);

		// Bottom: Skills
		this.renderAgentSkills(card, agent);
	}

	private renderAgentSkills(parent: HTMLElement, agent: INeocodeSwarmAgentConfig): void {
		if (!agent.skills) {
			agent.skills = [];
		}
		const container = DOM.append(parent, DOM.$('.neocode-agent-skills-section'));
		const header = DOM.append(container, DOM.$('.neocode-skills-header'));
		DOM.append(header, DOM.$('span.skills-label', undefined, localize('neoSwarm.agentSkills', "Habilidades (Tools)")));
		this.appendButton(header, localize('neoSwarm.addSkill', "Adicionar"), () => {
			agent.skills!.push({
				id: generateUuid(),
				name: localize('neoSwarm.newSkill', "Nova Habilidade"),
				type: 'terminal'
			});
			this.renderActiveTab();
		});

		const skillsList = DOM.append(container, DOM.$('.neocode-agent-skills-list'));
		agent.skills.forEach((skill, sIdx) => {
			const skillRow = DOM.append(skillsList, DOM.$('.neocode-skill-row'));
			const nameInput = DOM.append(skillRow, DOM.$('input.neocode-input-small', { type: 'text', value: skill.name })) as HTMLInputElement;
			this.tabDisposables.add(DOM.addDisposableListener(nameInput, DOM.EventType.CHANGE, () => skill.name = nameInput.value));

			const typeSelect = DOM.append(skillRow, DOM.$('select.neocode-select-small')) as HTMLSelectElement;
			[
				{ value: 'terminal', label: localize('neoSwarm.skillType.terminal', "Terminal") },
				{ value: 'filesystem', label: localize('neoSwarm.skillType.filesystem', "Arquivos") },
				{ value: 'search', label: localize('neoSwarm.skillType.search', "Busca") },
				{ value: 'codebase', label: localize('neoSwarm.skillType.codebase', "Codebase") }
			].forEach(opt => {
				const o = DOM.append(typeSelect, DOM.$('option', { value: opt.value }, opt.label)) as HTMLOptionElement;
				if (skill.type === opt.value) o.selected = true;
			});
			this.tabDisposables.add(DOM.addDisposableListener(typeSelect, DOM.EventType.CHANGE, () => skill.type = typeSelect.value as any));

			this.appendButton(skillRow, localize('neoSwarm.removeSkill', "X"), () => {
				agent.skills!.splice(sIdx, 1);
				this.renderActiveTab();
			}).classList.add('danger');
		});
	}

	private renderCapabilitiesTab(container: HTMLElement): void {
		if (this.toolbar) {
			this.toolbar.style.display = 'flex';
			const saveAllButton = this.appendButton(this.toolbar, localize('neoSwarm.saveAll', "Salvar tudo"), () => {
				this.saveConfig(localize('neoSwarm.saved', "Capacidades salvas."));
			});
			saveAllButton.classList.add('primary');
		}

		DOM.append(container, DOM.$('h3', undefined, localize('neoSwarm.capabilitiesTitle', "Capacidades Globais (Skills, Hooks, Personalidades)")));
		DOM.append(container, DOM.$('.neocode-note', undefined, localize('neoSwarm.capabilitiesHelp', "Configure e defina capacidades que seus agentes podem utilizar.")));

		// Sub-tabs navigation
		const nav = DOM.append(container, DOM.$('.neocode-swarm-subnav'));
		nav.style.display = 'flex';
		nav.style.gap = '16px';
		nav.style.marginBottom = '24px';
		nav.style.borderBottom = '1px solid var(--vscode-widget-border)';
		nav.style.paddingBottom = '8px';

		const tabs: { id: 'personalities' | 'skills' | 'hooks' | 'commands'; label: string; icon: ThemeIcon }[] = [
			{ id: 'personalities', label: localize('neoSwarm.capPersonalities', "Personalidades"), icon: Codicon.person },
			{ id: 'skills', label: localize('neoSwarm.capSkills', "Habilidades (Skills)"), icon: Codicon.tools },
			{ id: 'hooks', label: localize('neoSwarm.capHooks', "Gatilhos (Hooks)"), icon: Codicon.gitMerge },
			{ id: 'commands', label: localize('neoSwarm.capCommands', "Comandos"), icon: Codicon.terminalCmd }
		];

		tabs.forEach(tab => {
			const btn = DOM.append(nav, DOM.$('button.neocode-swarm-tab', { type: 'button' })) as HTMLButtonElement;
			if (this.activeCapabilityTab === tab.id) {
				btn.classList.add('active');
			}

			DOM.append(btn, DOM.$(`span${ThemeIcon.asCSSSelector(tab.icon)} `));
			DOM.append(btn, DOM.$('span', undefined, tab.label));

			this.tabDisposables.add(DOM.addDisposableListener(btn, DOM.EventType.CLICK, () => {
				this.activeCapabilityTab = tab.id;
				this.renderActiveTab();
			}));
		});

		const sectionContainer = DOM.append(container, DOM.$('.neocode-capabilities-container'));

		if (this.activeCapabilityTab === 'personalities') {
			this.renderCapabilitiesSection(sectionContainer, localize('neoSwarm.capPersonalities', "Personalidades"), this.config.capabilities.personalities, () => {
				const id = generateUuid();
				this.config.capabilities.personalities.unshift({ id, name: localize('neoSwarm.newPersonality', "Nova Personalidade"), soulRule: '', sourcePath: '' });
				this.expandedCapabilities.add(id);
				this.renderActiveTab();
			}, (item, parent) => {
				const grid = DOM.append(parent, DOM.$('.neocode-capability-item-details-grid'));
				this.appendLabeledInput(grid, localize('neoSwarm.name', "Nome"), item.name, v => item.name = v);
				this.appendLabeledInput(grid, localize('neoSwarm.description', "Descricao"), item.description ?? '', v => item.description = v || undefined);
				this.appendPathInputWithOpenButton(
					parent,
					localize('neoSwarm.sourcePath', "Caminho da Regra (MD)"),
					item.sourcePath ?? '',
					v => item.sourcePath = v || undefined,
					localize('neoSwarm.browse', "Procurar"),
					() => this.browseCapabilityFile(v => { item.sourcePath = v; this.renderActiveTab(); }),
					localize('neoSwarm.openSourceFile', "Abrir arquivo"),
					() => this.openCapabilityFile(item.sourcePath, localize('neoSwarm.capability.personality', "personalidade"))
				);
				this.appendLabeledTextArea(parent, localize('neoSwarm.soulRule', "Regra de Alma"), item.soulRule, v => item.soulRule = v);

				const loadActionRow = DOM.append(parent, DOM.$('.neocode-actions-row', { style: 'margin-top: 10px; justify-content: flex-end;' }));
				this.appendButton(loadActionRow, localize('neoSwarm.loadFromFile', "Carregar conteudo do arquivo"), async () => {
					const rawPath = item.sourcePath?.trim();
					if (!rawPath) {
						this.notificationService.warn(localize('neoSwarm.loadFromFile.missingPath', "Defina um caminho de arquivo primeiro."));
						return;
					}
					const targets = this.buildCapabilityFileOpenTargets(rawPath);
					let target = targets[0];
					let found = false;
					for (const candidate of targets) {
						try {
							if (await this.fileService.exists(candidate)) {
								target = candidate;
								found = true;
								break;
							}
						} catch {
						}
					}
					if (!found) {
						this.notificationService.warn(localize('neoSwarm.loadFromFile.notFound', "Arquivo nao encontrado: {0}", rawPath));
						return;
					}
					try {
						const content = await this.fileService.readFile(target);
						item.soulRule = content.value.toString();
						this.renderActiveTab();
					} catch (error) {
						this.notificationService.error(localize('neoSwarm.loadFromFile.error', "Erro ao ler arquivo: {0}", error instanceof Error ? error.message : String(error)));
					}
				});
			});
		} else if (this.activeCapabilityTab === 'skills') {
			this.renderCapabilitiesSection(sectionContainer, localize('neoSwarm.capSkills', "Habilidades (Skills)"), this.config.capabilities.skills, () => {
				const id = generateUuid();
				this.config.capabilities.skills.unshift({
					id,
					name: localize('neoSwarm.newSkill', "Nova Habilidade"),
					type: 'custom',
					description: '',
					instructionPath: ''
				});
				this.expandedCapabilities.add(id);
				this.renderActiveTab();
			}, (item, parent) => {
				const grid = DOM.append(parent, DOM.$('.neocode-capability-item-details-grid'));
				this.appendLabeledInput(grid, localize('neoSwarm.name', "Nome"), item.name, v => item.name = v);
				this.appendSelect(grid, localize('neoSwarm.skillType', "Tipo"), item.type, [
					{ value: 'terminal', label: localize('neoSwarm.skillType.terminal', "Terminal") },
					{ value: 'filesystem', label: localize('neoSwarm.skillType.filesystem', "Arquivos") },
					{ value: 'search', label: localize('neoSwarm.skillType.search', "Busca") },
					{ value: 'codebase', label: localize('neoSwarm.skillType.codebase', "Codebase") },
					{ value: 'custom', label: localize('neoSwarm.skillType.custom', "Customizado") }
				], v => item.type = v as any);
				this.appendLabeledInput(parent, localize('neoSwarm.description', "Descricao"), item.description ?? '', v => item.description = v || undefined);
				this.appendPathInputWithOpenButton(
					parent,
					localize('neoSwarm.skillInstructionPath', "Arquivo de Instrucao (MD)"),
					item.instructionPath ?? '',
					v => item.instructionPath = v || undefined,
					localize('neoSwarm.browse', "Procurar"),
					() => this.browseCapabilityFile(v => { item.instructionPath = v; this.renderActiveTab(); }),
					localize('neoSwarm.openInstructionFile', "Abrir arquivo"),
					() => this.openCapabilityFile(item.instructionPath, localize('neoSwarm.capability.skill', "habilidade"))
				);
			});
		} else if (this.activeCapabilityTab === 'hooks') {
			this.renderCapabilitiesSection(sectionContainer, localize('neoSwarm.capHooks', "Gatilhos (Hooks)"), this.config.capabilities.hooks, () => {
				const id = generateUuid();
				this.config.capabilities.hooks.unshift({ id, name: localize('neoSwarm.newHook', "Novo Gatilho") });
				this.expandedCapabilities.add(id);
				this.renderActiveTab();
			}, (item, parent) => {
				const grid = DOM.append(parent, DOM.$('.neocode-capability-item-details-grid'));
				this.appendLabeledInput(grid, localize('neoSwarm.name', "Nome"), item.name, v => item.name = v);
				this.appendLabeledInput(grid, localize('neoSwarm.description', "Descricao"), item.description ?? '', v => item.description = v || undefined);
				this.appendPathInputWithOpenButton(
					parent,
					localize('neoSwarm.scriptPath', "Caminho do Script"),
					item.scriptPath ?? '',
					v => item.scriptPath = v || undefined,
					localize('neoSwarm.browse', "Procurar"),
					() => this.browseCapabilityFile(v => { item.scriptPath = v; this.renderActiveTab(); }),
					localize('neoSwarm.openScriptFile', "Abrir arquivo"),
					() => this.openCapabilityFile(item.scriptPath, localize('neoSwarm.capability.hook', "gatilho"))
				);
			});
		} else if (this.activeCapabilityTab === 'commands') {
			this.renderCapabilitiesSection(sectionContainer, localize('neoSwarm.capCommands', "Comandos"), this.config.capabilities.commands, () => {
				const id = generateUuid();
				this.config.capabilities.commands.unshift({ id, name: localize('neoSwarm.newCommand', "Novo Comando") });
				this.expandedCapabilities.add(id);
				this.renderActiveTab();
			}, (item, parent) => {
				const grid = DOM.append(parent, DOM.$('.neocode-capability-item-details-grid'));
				this.appendLabeledInput(grid, localize('neoSwarm.name', "Nome"), item.name, v => item.name = v);
				this.appendLabeledInput(grid, localize('neoSwarm.description', "Descricao"), item.description ?? '', v => item.description = v || undefined);
				this.appendPathInputWithOpenButton(
					parent,
					localize('neoSwarm.executablePath', "Ponto de Entrada/Executavel"),
					item.executablePath ?? '',
					v => item.executablePath = v || undefined,
					localize('neoSwarm.browse', "Procurar"),
					() => this.browseCapabilityFile(v => { item.executablePath = v; this.renderActiveTab(); }),
					localize('neoSwarm.openCommandFile', "Abrir arquivo"),
					() => this.openCapabilityFile(item.executablePath, localize('neoSwarm.capability.command', "comando"))
				);
			});
		}
	}

	private renderCapabilitiesSection<T extends { id: string; name: string; description?: string; type?: string }>(
		container: HTMLElement,
		title: string,
		list: T[],
		onAdd: () => void,
		renderItem: (item: T, parent: HTMLElement, index: number) => void
	): void {
		const header = DOM.append(container, DOM.$('.neocode-title-row'));
		DOM.append(header, DOM.$('h4', { style: 'margin: 0;' }, title));
		this.appendButton(header, localize('neoSwarm.add', "Adicionar"), onAdd);

		const section = DOM.append(container, DOM.$('.neocode-capabilities-section'));

		list.forEach((item, index) => {
			const itemContainer = DOM.append(section, DOM.$('.neocode-capability-item'));
			const isExpanded = this.expandedCapabilities.has(item.id);
			if (isExpanded) {
				itemContainer.classList.add('expanded');
			}

			// Header
			const header = DOM.append(itemContainer, DOM.$('.neocode-capability-item-header'));
			const titleContainer = DOM.append(header, DOM.$('.neocode-capability-item-title'));
			DOM.append(titleContainer, DOM.$(`span.codicon.codicon - chevron - right.neocode - expand - icon`));
			DOM.append(titleContainer, DOM.$('span.neocode-capability-item-name', undefined, item.name));

			if (item.type) {
				DOM.append(titleContainer, DOM.$('span.neocode-badge', undefined, item.type));
			}

			if (item.description) {
				DOM.append(titleContainer, DOM.$('span.neocode-capability-item-description-summary', undefined, item.description));
			}

			const actions = DOM.append(header, DOM.$('.neocode-capability-item-actions'));

			this.appendButton(actions, localize('neoSwarm.remove', "Remover"), () => {
				list.splice(index, 1);
				this.expandedCapabilities.delete(item.id);
				this.renderActiveTab();
			}).classList.add('danger');

			this.tabDisposables.add(DOM.addDisposableListener(header, DOM.EventType.CLICK, () => {
				if (this.expandedCapabilities.has(item.id)) {
					this.expandedCapabilities.delete(item.id);
					itemContainer.classList.remove('expanded');
				} else {
					this.expandedCapabilities.add(item.id);
					itemContainer.classList.add('expanded');
				}
			}));

			// Content
			const content = DOM.append(itemContainer, DOM.$('.neocode-capability-item-content'));
			renderItem(item, content, index);
		});

		if (list.length === 0) {
			DOM.append(section, DOM.$('.neocode-placeholder', undefined, localize('neoSwarm.noCapabilities', "Nenhuma capacidade definida.")));
		}
	}



	private renderSecurityTab(container: HTMLElement): void {
		DOM.append(container, DOM.$('h3', undefined, localize('neoSwarm.securityTitle', "Seguranca")));
		const form = DOM.append(container, DOM.$('.neocode-form-grid'));
		this.appendToggle(form, localize('neoSwarm.maskSensitiveLogs', "Mascarar saida sensivel em logs"), this.config.security.maskSensitiveLogs, value => this.config.security.maskSensitiveLogs = value);
		this.appendToggle(form, localize('neoSwarm.blockCli', "Bloquear execucao de CLI sem confirmacao"), this.config.security.blockCliExecutionWithoutConfirmation, value => this.config.security.blockCliExecutionWithoutConfirmation = value);

		const revealDanger = this.appendButton(container, localize('neoSwarm.showDangerZone', "Mostrar zona de perigo"), () => {
			dangerZone.classList.toggle('revealed');
			revealDanger.textContent = dangerZone.classList.contains('revealed')
				? localize('neoSwarm.hideDangerZone', "Ocultar zona de perigo")
				: localize('neoSwarm.showDangerZone', "Mostrar zona de perigo");
		});

		const dangerZone = DOM.append(container, DOM.$('.neocode-danger-zone'));
		DOM.append(dangerZone, DOM.$('h4', undefined, localize('neoSwarm.dangerZone', "Zona de Perigo")));
		DOM.append(dangerZone, DOM.$('p', undefined, localize('neoSwarm.dangerZoneHelp', "Estas acoes sao destrutivas. Exija sempre confirmacao dupla.")));

		this.appendButton(dangerZone, localize('neoSwarm.resetDefaults', "Restaurar padroes de fabrica"), async () => {
			const confirmation = await this.dialogService.confirm({
				type: 'warning',
				message: localize('neoSwarm.resetConfirmTitle', "Restaurar configuracoes do enxame?"),
				detail: localize('neoSwarm.resetConfirmDetail', "Isso restaura configuracoes nao sensiveis. Tokens seguros sao preservados. Confirme novamente para continuar."),
				primaryButton: localize('neoSwarm.resetConfirmPrimary', "Restaurar")
			});
			if (!confirmation.confirmed) return;
			const secondConfirmation = await this.dialogService.confirm({
				type: 'warning',
				message: localize('neoSwarm.resetConfirmSecondTitle', "Confirmacao final"),
				detail: localize('neoSwarm.resetConfirmSecondDetail', "Tem certeza absoluta? Esta acao remove a configuracao atual do enxame."),
				primaryButton: localize('neoSwarm.resetConfirmSecondPrimary', "Sim, restaurar agora")
			});
			if (!secondConfirmation.confirmed) return;
			this.config = createDefaultNeocodeSwarmConfig();
			this.selectedProviderId = this.config.providers[0]?.id;
			this.saveConfig(localize('neoSwarm.resetDone', "Configuracao restaurada."), true);
			await this.refreshSecretMasks();
			this.renderActiveTab();
		}).classList.add('danger');
	}

	private renderAdvancedTab(container: HTMLElement): void {
		DOM.append(container, DOM.$('h3', undefined, localize('neoSwarm.advancedTitle', "Avancado")));
		const form = DOM.append(container, DOM.$('.neocode-form-grid'));
		this.appendRange(form, localize('neoSwarm.advancedConcurrency', "Concorrencia"), this.config.advanced.concurrency, 1, 8, 1, value => this.config.advanced.concurrency = Math.round(value));
		this.appendSelect(form, localize('neoSwarm.advancedRouting', "Estrategia de roteamento"), this.config.advanced.routingStrategy, [
			{ value: 'orchestratorDecides', label: localize('neoSwarm.routing.orchestrator', "Orquestrador decide") },
			{ value: 'fixedByRole', label: localize('neoSwarm.routing.fixed', "Fixo por papel") },
			{ value: 'priorityFallback', label: localize('neoSwarm.routing.fallback', "Fallback por prioridade") }
		], value => this.config.advanced.routingStrategy = value as INeocodeSwarmConfig['advanced']['routingStrategy']);
		this.appendToggle(form, localize('neoSwarm.advancedFallback', "Fallback para proximo provedor"), this.config.advanced.fallbackToNextProvider, value => this.config.advanced.fallbackToNextProvider = value);
		this.appendToggle(form, localize('neoSwarm.advancedTrace', "Salvar trace do enxame (sem segredos)"), this.config.advanced.saveTraceWithoutSecrets, value => this.config.advanced.saveTraceWithoutSecrets = value);
		this.appendToggle(form, localize('neoSwarm.advancedEvents', "Mostrar painel de eventos"), this.config.advanced.showEventsPanel, value => this.config.advanced.showEventsPanel = value);
		this.appendToggle(form, localize('neoSwarm.advancedRouteOrchestrator', "Rotear tudo via orquestrador"), this.config.advanced.routeAllThroughOrchestrator, value => this.config.advanced.routeAllThroughOrchestrator = value);
		this.appendToggle(form, localize('neoSwarm.advancedAgentDirect', "Permitir comunicacao direta entre agentes"), this.config.advanced.allowDirectAgentCommunication, value => this.config.advanced.allowDirectAgentCommunication = value);
		this.appendToggle(form, localize('neoSwarm.advancedAsync', "Execucao assincrona"), this.config.advanced.asyncExecution, value => this.config.advanced.asyncExecution = value);
		this.appendToggle(form, localize('neoSwarm.advancedPartition', "Particionar tarefas grandes"), this.config.advanced.partitionLargeTasks, value => this.config.advanced.partitionLargeTasks = value);
		this.appendToggle(form, localize('neoSwarm.advancedEnforceSkills', "Forcar uso de skills"), this.config.advanced.enforceSkills, value => this.config.advanced.enforceSkills = value);
		this.appendLabeledInput(form, localize('neoSwarm.advancedSkillsDir', "Diretorio de skills"), this.config.advanced.skillsDirectory ?? '.neocode/skills', value => this.config.advanced.skillsDirectory = value || undefined);
		this.appendToggle(form, localize('neoSwarm.advancedIsDeveloperMode', "Sou desenvolvedor"), this.config.advanced.isDeveloperMode, value => {
			this.config.advanced.isDeveloperMode = value;
			this.renderActiveTab();
		});

		const actions = DOM.append(container, DOM.$('.neocode-actions-row'));
		this.appendButton(actions, localize('neoSwarm.saveAdvanced', "Salvar avancado"), () => this.saveConfig(localize('neoSwarm.advancedSaved', "Configuracoes avancadas salvas.")), true);
	}

	// --- Helper UI Methods ---

	private appendLabeledInput(parent: HTMLElement, label: string, value: string, onChange: (v: string) => void): HTMLElement {
		const row = DOM.append(parent, DOM.$('.neocode-field-row'));
		DOM.append(row, DOM.$('label', undefined, label));
		const input = DOM.append(row, DOM.$('input.neocode-input', { type: 'text', value })) as HTMLInputElement;
		this.tabDisposables.add(DOM.addDisposableListener(input, DOM.EventType.CHANGE, () => onChange(input.value)));
		return row;
	}

	private appendPathInputWithOpenButton(
		parent: HTMLElement,
		label: string,
		value: string,
		onChange: (v: string) => void,
		browseButtonLabel: string,
		onBrowse: () => void,
		openButtonLabel: string,
		onOpen: () => void
	): HTMLElement {
		const row = DOM.append(parent, DOM.$('.neocode-field-row'));
		DOM.append(row, DOM.$('label', undefined, label));

		const controls = DOM.append(row, DOM.$('.neocode-field-row-actions'));
		const displayValue = this.toCapabilityPathDisplayValue(value);
		const input = DOM.append(controls, DOM.$('input.neocode-input', { type: 'text', value: displayValue })) as HTMLInputElement;
		this.tabDisposables.add(DOM.addDisposableListener(input, DOM.EventType.CHANGE, () => onChange(normalizeCapabilityPathInput(input.value))));

		this.appendButton(controls, browseButtonLabel, onBrowse);
		this.appendButton(controls, openButtonLabel, onOpen);
		return row;
	}

	private toCapabilityPathDisplayValue(value: string): string {
		const normalized = normalizeCapabilityPathInput(value);
		if (!normalized) {
			return normalized;
		}

		if (isAbsoluteFilePath(normalized)) {
			return normalized;
		}

		const appPreferred = this.resolveAppPreferredPath(normalized);
		if (appPreferred?.scheme === 'file') {
			return appPreferred.fsPath;
		}

		return normalized;
	}

	private async browseCapabilityFile(onSelect: (path: string) => void): Promise<void> {
		const result = await this.fileDialogService.showOpenDialog({
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			title: localize('neoSwarm.selectFile', "Selecionar arquivo"),
			availableFileSystems: [this.pathService.defaultUriScheme]
		});

		if (result && result.length > 0) {
			const selectedUri = result[0];
			let selectedPath = selectedUri.fsPath.replace(/\\/g, '/');

			// Try to make it relative to any workspace folder
			for (const folder of this.workspaceContextService.getWorkspace().folders) {
				const folderPath = folder.uri.fsPath.replace(/\\/g, '/');
				if (this.isPrefixOf(folderPath, selectedPath)) {
					const relative = selectedPath.substring(folderPath.length).replace(/^\/+/, '');
					selectedPath = relative ? `\${workspaceFolder}/${relative}` : '${workspaceFolder}';
					break;
				}
			}

			onSelect(normalizeCapabilityPathInput(selectedPath));
		}
	}

	private isPrefixOf(prefix: string, str: string): boolean {
		if (str.length < prefix.length) return false;
		return str.toLowerCase().replace(/\\/g, '/').startsWith(prefix.toLowerCase().replace(/\\/g, '/'));
	}

	private appendLabeledTextArea(parent: HTMLElement, label: string | HTMLElement, value: string, onChange: (v: string) => void): HTMLElement {
		const row = DOM.append(parent, DOM.$('.neocode-field-row.neocode-textarea-row'));
		const labelContainer = DOM.append(row, DOM.$('label'));
		if (typeof label === 'string') {
			labelContainer.textContent = label;
		} else {
			DOM.append(labelContainer, label);
		}
		const textarea = DOM.append(row, DOM.$('textarea.neocode-textarea', undefined, value)) as HTMLTextAreaElement;
		this.tabDisposables.add(DOM.addDisposableListener(textarea, DOM.EventType.CHANGE, () => onChange(textarea.value)));
		return row;
	}

	private appendToggle(parent: HTMLElement, label: string, checked: boolean, onChange: (v: boolean) => void): HTMLElement {
		const row = DOM.append(parent, DOM.$('.neocode-checkbox-row'));
		const checkbox = DOM.append(row, DOM.$('input', { type: 'checkbox' })) as HTMLInputElement;
		checkbox.checked = checked;
		this.tabDisposables.add(DOM.addDisposableListener(checkbox, DOM.EventType.CHANGE, () => onChange(checkbox.checked)));
		DOM.append(row, DOM.$('label', undefined, label));
		return row;
	}

	private appendSelect(parent: HTMLElement, label: string, value: string, options: { value: string, label: string }[], onChange: (v: string) => void): HTMLElement {
		const row = DOM.append(parent, DOM.$('.neocode-field-row'));
		DOM.append(row, DOM.$('label', undefined, label));
		const select = DOM.append(row, DOM.$('select.neocode-select')) as HTMLSelectElement;
		for (const opt of options) {
			const o = DOM.append(select, DOM.$('option', { value: opt.value }, opt.label)) as HTMLOptionElement;
			if (opt.value === value) o.selected = true;
		}
		this.tabDisposables.add(DOM.addDisposableListener(select, DOM.EventType.CHANGE, () => onChange(select.value)));
		return row;
	}

	private appendRange(parent: HTMLElement, label: string, value: number, min: number, max: number, step: number, onChange: (v: number) => void): HTMLElement {
		const row = DOM.append(parent, DOM.$('.neocode-field-row'));
		DOM.append(row, DOM.$('label', undefined, label));
		const range = DOM.append(row, DOM.$('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) })) as HTMLInputElement;
		const valDisplay = DOM.append(row, DOM.$('span.neocode-range-value', undefined, String(value)));
		this.tabDisposables.add(DOM.addDisposableListener(range, DOM.EventType.INPUT, () => {
			valDisplay.textContent = range.value;
			onChange(parseFloat(range.value));
		}));
		return row;
	}

	private appendButton(parent: HTMLElement, label: string, onClick: () => void, primary = false): HTMLButtonElement {
		const button = DOM.append(parent, DOM.$('button.neocode-swarm-button', undefined, label)) as HTMLButtonElement;
		if (primary) button.classList.add('primary');
		this.tabDisposables.add(DOM.addDisposableListener(button, DOM.EventType.CLICK, onClick));
		return button;
	}

	private async openCapabilityFile(rawPath: string | undefined, capabilityTypeLabel: string): Promise<void> {
		const value = rawPath?.trim();
		if (!value) {
			this.notificationService.warn(localize('neoSwarm.openFile.missingPath', "Defina um caminho de arquivo para este {0}.", capabilityTypeLabel));
			return;
		}

		const targets = this.buildCapabilityFileOpenTargets(value);
		let target = targets[0];
		for (const candidate of targets) {
			try {
				if (await this.fileService.exists(candidate)) {
					target = candidate;
					break;
				}
			} catch {
				// Ignore provider-specific lookup errors and keep trying candidates.
			}
		}

		try {
			await this.openerService.open(target);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			this.notificationService.error(localize('neoSwarm.openFile.failed', "Nao foi possivel abrir o arquivo: {0}", detail));
		}
	}

	private buildCapabilityFileOpenTargets(value: string): URI[] {
		const normalizedInput = normalizeCapabilityPathInput(value);

		const candidates: URI[] = [];
		const seen = new Set<string>();
		const pushUnique = (candidate: URI) => {
			const key = candidate.toString();
			if (!seen.has(key)) {
				seen.add(key);
				candidates.push(candidate);
			}
		};

		const appPreferred = this.resolveAppPreferredPath(normalizedInput);
		if (appPreferred) {
			pushUnique(appPreferred);
		}

		const workspaceExpanded = this.expandWorkspaceFolderVariable(normalizedInput);
		if (workspaceExpanded.length) {
			for (const expanded of workspaceExpanded) {
				for (const target of this.buildCapabilityFileOpenTargets(expanded)) {
					pushUnique(target);
				}
			}
			return candidates;
		}

		if (hasUriScheme(normalizedInput)) {
			pushUnique(URI.parse(normalizedInput));
			return candidates;
		}

		// 1. Try variable resolution
		const resolved = this.resolveVariables(normalizedInput);
		for (const r of resolved) {
			if (isAbsoluteFilePath(r)) {
				pushUnique(URI.file(r));
			} else if (hasUriScheme(r)) {
				pushUnique(URI.parse(r));
			}
		}

		// 2. Try home path expansion (legacy and ~)
		const expanded = expandHomePath(normalizedInput);
		if (expanded && isAbsoluteFilePath(expanded)) {
			pushUnique(URI.file(expanded));
		}

		// 3. Try absolute path directly
		if (isAbsoluteFilePath(normalizedInput)) {
			pushUnique(URI.file(normalizedInput));
		}

		// 4. Try as relative path to workspace folders and CWD
		const normalized = normalizeRelativePath(normalizedInput);
		for (const folder of this.workspaceContextService.getWorkspace().folders) {
			pushUnique(URI.joinPath(folder.uri, normalized));
		}

		const cwd = getProcessCwd();
		if (cwd) {
			for (const dir of getAncestorDirectories(cwd, 8)) {
				pushUnique(URI.joinPath(URI.file(dir), normalized));
			}
		}

		if (!candidates.length) {
			pushUnique(URI.file(normalized));
		}

		return candidates;
	}

	private resolveAppPreferredPath(value: string): URI | undefined {
		const withoutWorkspaceVar = value.replace(/^\$\{workspaceFolder\}\//, '');
		const candidatePath = normalizeCapabilityPathInput(withoutWorkspaceVar);
		if (!candidatePath.startsWith('models/')) {
			return undefined;
		}

		try {
			return FileAccess.asFileUri(`vs/../../${candidatePath}` as AppResourcePath);
		} catch {
			return undefined;
		}
	}

	private expandWorkspaceFolderVariable(value: string): string[] {
		if (!value.includes('${workspaceFolder}')) {
			return [];
		}

		const expanded: string[] = [];
		const seen = new Set<string>();
		const pushUnique = (candidate: string | undefined) => {
			if (!candidate) {
				return;
			}
			const normalized = candidate.trim();
			if (!normalized || seen.has(normalized)) {
				return;
			}
			seen.add(normalized);
			expanded.push(normalized);
		};

		for (const folder of this.workspaceContextService.getWorkspace().folders) {
			if (folder.uri.scheme === 'file') {
				pushUnique(value.replace(/\$\{workspaceFolder\}/g, folder.uri.fsPath));
			} else {
				pushUnique(value.replace(/\$\{workspaceFolder\}/g, folder.uri.toString()));
			}
		}

		const cwd = getProcessCwd();
		pushUnique(cwd ? value.replace(/\$\{workspaceFolder\}/g, cwd) : undefined);
		return expanded;
	}

	private resolveVariables(value: string): string[] {
		const results: string[] = [];

		// Handle ${userHome} and ${cwd} which are unique
		let base = value;
		// Use path service for home
		const home = this.pathService.userHome({ preferLocal: true }).fsPath;
		const cwd = getProcessCwd() || '';

		if (home) base = base.replace(/\$\{userHome\}/g, home);
		if (cwd) base = base.replace(/\$\{cwd\}/g, cwd);

		// Handle ${workspaceFolder} which can be multiple
		if (base.includes('${workspaceFolder}')) {
			const folders = this.workspaceContextService.getWorkspace().folders;
			for (const folder of folders) {
				results.push(base.replace(/\$\{workspaceFolder\}/g, folder.uri.fsPath));
			}
			if (!folders.length && cwd) {
				results.push(base.replace(/\$\{workspaceFolder\}/g, cwd));
			}
		} else {
			results.push(base);
		}

		return results.map(normalizeCapabilityPathInput);
	}

	private providerAuthOptions(type: INeocodeSwarmProviderConfig['type']): { value: string, label: string }[] {
		if (type === 'qwen-code') {
			return [
				{ value: 'qwen-oauth', label: localize('neoSwarm.auth.qwenOAuth', "Qwen OAuth") },
				{ value: 'apiKey', label: localize('neoSwarm.auth.apiKey', "API Key (@openai)") }
			];
		}
		const options = [
			{ value: 'apiKey', label: localize('neoSwarm.auth.apiKey', "API Key") },
			{ value: 'login', label: localize('neoSwarm.auth.login', "Login por Navegador") }
		];
		if (type !== 'custom') {
			options.push({ value: 'cliToken', label: localize('neoSwarm.auth.cli', "Token via CLI") });
		}
		return options;
	}

	private enabledModelOptions(): { value: string, label: string }[] {
		return [
			{ value: '', label: localize('neoSwarm.noProviderSelected', "Nenhum") },
			...this.config.providers.filter(p => p.enabled).map(p => ({ value: p.id, label: p.name }))
		];
	}

	private orchestratorModelOptions(): { value: string, label: string }[] {
		const provider = this.config.providers.find(p => p.id === this.config.orchestrator.providerId);
		const models = provider?.models ?? [];
		if (!models.length) {
			return [{ value: '', label: localize('neoSwarm.noModelAvailable', "Nenhum modelo disponivel") }];
		}
		return models.map(model => ({ value: model, label: model }));
	}

	private async handleProviderTest(provider: INeocodeSwarmProviderConfig): Promise<void> {
		this.updateStatus(localize('neoSwarm.testing', "Testando..."));
		this.providerTestState.set(provider.id, { busy: true });
		this.renderActiveTab();

		let result: { ok: boolean; message: string };
		if (provider.type === 'gemini') {
			const geminiConfig = this.geminiAuthService.loadConfig();
			result = geminiConfig.authType === 'apiKey'
				? await this.geminiAuthService.testApiKeyConnection()
				: await this.geminiAuthService.testGoogleLoginConnection();
		} else if (provider.type === 'anthropic' && provider.authMethod === 'login') {
			result = await this.testAnthropicLoginConnection();
		} else if (provider.type === 'qwen-code' && provider.authMethod === 'qwen-oauth') {
			result = await this.qwenAuthService.testApiKeyConnection();
		} else {
			const secret = await this.getProviderSecretWithFallback(provider, provider.authMethod === 'apiKey' ? 'apiKey' : 'loginToken');
			result = await this.providerTest.testConnection(provider, secret ?? '');
		}

		this.providerTestState.set(provider.id, { busy: false, ok: result.ok, message: result.message });
		provider.status = result.ok ? 'connected' : 'error';
		provider.statusMessage = result.message;
		this.saveConfig(undefined, true);
		this.renderActiveTab();
		this.updateStatus(result.message, !result.ok);
	}

	private async startLoginFlow(provider: INeocodeSwarmProviderConfig): Promise<void> {
		if (provider.type === 'openai') {
			await this.handleOpenAIConnect(provider);
			return;
		}
		if (provider.type === 'anthropic') {
			await this.handleAnthropicLogin(provider);
			return;
		}

		const url = this.providerLoginUrl(provider.type);
		if (!url) {
			this.updateStatus(localize('neoSwarm.loginProviderUnsupported', "Este provedor nao possui fluxo de login automatico. Cole o token manualmente."), true);
			return;
		}

		try {
			const opened = await this.openerService.open(URI.parse(url), {
				openExternal: true,
				allowContributedOpeners: false
			});
			if (!opened) {
				this.updateStatus(localize('neoSwarm.loginBrowserOpenFailed', "Nao foi possivel abrir o navegador para login."), true);
				return;
			}
			this.updateStatus(localize('neoSwarm.loginBrowserOpened', "Navegador aberto. Conclua o login e cole o token abaixo."));
		} catch {
			this.updateStatus(localize('neoSwarm.loginBrowserOpenFailed', "Nao foi possivel abrir o navegador para login."), true);
		}
	}

	private providerLoginUrl(type: NeocodeSwarmProviderType): string | undefined {
		switch (type) {
			case 'gemini': return 'https://aistudio.google.com';
			case 'openai': return 'https://platform.openai.com';
			case 'anthropic': return 'https://console.anthropic.com';
			case 'qwen-code': return 'https://qwenlm.github.io/qwen-code-docs/';
			default: return undefined;
		}
	}

	private async handleAnthropicLogin(provider: INeocodeSwarmProviderConfig): Promise<void> {
		const cliPath = this.resolveAnthropicCliPath();
		this.updateStatus(localize('neoSwarm.anthropicLoginStarting', "Iniciando login Anthropic via Claude CLI..."));
		const run = await this.runCliExec(cliPath, ['auth', 'login'], 8 * 60 * 1000);
		if (run.exitCode !== 0) {
			const probe = await this.testAnthropicLoginConnection();
			if (probe.ok) {
				provider.status = 'connected';
				provider.statusMessage = probe.message;
				this.saveConfig(undefined, true);
				this.renderActiveTab();
				this.updateStatus(probe.message);
				return;
			}
			const detail = [run.stderr, run.stdout].filter(Boolean).join('\n').trim();
			const message = detail
				? localize('neoSwarm.anthropicLoginFailedDetail', "Falha no login Anthropic: {0}. Se houver callback localhost com erro, copie o parametro code da URL e refaca `claude auth login` no terminal.", detail)
				: localize('neoSwarm.anthropicLoginFailed', "Falha ao executar `claude auth login`.");
			provider.status = 'error';
			provider.statusMessage = message;
			this.saveConfig(undefined, true);
			this.renderActiveTab();
			this.updateStatus(message, true);
			return;
		}

		const test = await this.testAnthropicLoginConnection();
		provider.status = test.ok ? 'connected' : 'error';
		provider.statusMessage = test.message;
		this.saveConfig(undefined, true);
		this.renderActiveTab();
		this.updateStatus(test.message, !test.ok);
	}

	private async handleAnthropicLogout(provider: INeocodeSwarmProviderConfig): Promise<void> {
		const cliPath = this.resolveAnthropicCliPath();
		this.updateStatus(localize('neoSwarm.anthropicLogoutStarting', "Encerrando sessao Anthropic via Claude CLI..."));
		const logoutRun = await this.runCliExec(cliPath, ['auth', 'logout'], 60_000);
		const statusAfter = await this.testAnthropicLoginConnection();

		if (!statusAfter.ok) {
			const scope = this.providerSecretScope(provider);
			await this.secrets.setProviderSecret(scope, 'loginToken', '');
			if (scope !== provider.id) {
				await this.secrets.setProviderSecret(provider.id, 'loginToken', '');
			}
			await this.refreshSecretMasks();
			provider.status = 'notConfigured';
			provider.statusMessage = localize('neoSwarm.anthropicLoggedOut', "Sessao Anthropic encerrada.");
			this.saveConfig(undefined, true);
			this.renderActiveTab();
			this.updateStatus(provider.statusMessage);
			return;
		}

		const detail = [logoutRun.stderr, logoutRun.stdout].filter(Boolean).join('\n').trim();
		const message = detail
			? localize('neoSwarm.anthropicLogoutFailedDetail', "Nao foi possivel deslogar Anthropic: {0}", detail)
			: localize('neoSwarm.anthropicLogoutFailed', "Nao foi possivel deslogar Anthropic.");
		provider.status = 'error';
		provider.statusMessage = message;
		this.saveConfig(undefined, true);
		this.renderActiveTab();
		this.updateStatus(message, true);
	}

	private async testAnthropicLoginConnection(): Promise<{ ok: boolean; message: string }> {
		const cliPath = this.resolveAnthropicCliPath();
		const status = await this.runCliExec(cliPath, ['auth', 'status', '--json'], 30_000);
		if (status.exitCode !== 0) {
			const detail = [status.stderr, status.stdout].filter(Boolean).join('\n').trim();
			return {
				ok: false,
				message: detail
					? localize('neoSwarm.anthropicAuthStatusFailedDetail', "Falha ao verificar sessao Anthropic: {0}", detail)
					: localize('neoSwarm.anthropicAuthStatusFailed', "Falha ao verificar sessao Anthropic via Claude CLI.")
			};
		}

		try {
			const parsed = JSON.parse(status.stdout) as {
				loggedIn?: boolean;
				email?: string;
				orgName?: string;
				subscriptionType?: string;
				authMethod?: string;
			};
			if (parsed.loggedIn) {
				const identity = parsed.email?.trim() || parsed.orgName?.trim() || 'Conta autenticada';
				const plan = parsed.subscriptionType?.trim() ? ` (${parsed.subscriptionType})` : '';
				return {
					ok: true,
					message: localize('neoSwarm.anthropicAuthConnected', "Anthropic conectado via Claude CLI: {0}{1}.", identity, plan)
				};
			}
			return {
				ok: false,
				message: localize('neoSwarm.anthropicAuthNotLoggedIn', "Sessao Anthropic ausente. Execute o login no Claude CLI.")
			};
		} catch {
			return {
				ok: false,
				message: localize('neoSwarm.anthropicAuthStatusInvalid', "Resposta invalida de `claude auth status--json`.")
			};
		}
	}

	private resolveAnthropicCliPath(): string {
		return 'claude';
	}

	private async runCliExec(command: string, args: string[], timeoutMs: number, stdin?: string): Promise<INeocodeSwarmCliExecResult> {
		let utilityProcessService: IUtilityProcessWorkerServiceLike;
		try {
			const module = await import('../../../services/utilityProcess/electron-browser/utilityProcessWorkerWorkbenchService.js');
			utilityProcessService = this.instantiationService.invokeFunction(accessor => accessor.get(module.IUtilityProcessWorkerWorkbenchService)) as IUtilityProcessWorkerServiceLike;
		} catch (error) {
			return {
				exitCode: 1,
				stdout: '',
				stderr: localize('neoSwarm.cliWorkerUnavailable', 'Nao foi possivel iniciar worker de CLI: {0}', error instanceof Error ? error.message : String(error)),
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

	private saveConfig(msg?: string, silent = false): void {
		this.storage.save(this.config);
		if (!silent && msg) {
			this.updateStatus(msg);
			this.notificationService.info(msg);
		}
	}

	private updateStatus(message: string, isError = false): void {
		if (this.statusBar) {
			this.statusBar.textContent = message;
			this.statusBar.classList.toggle('error', isError);
		}
	}

	private getProviderStatusIcon(providerId: string, fallbackStatus: NeocodeSwarmProviderStatus): string {
		const state = this.providerTestState.get(providerId);
		if (state?.busy) return 'codicon-loading codicon-modifier-spin';
		if (state?.ok === true) return 'codicon-check';
		if (state?.ok === false) return 'codicon-error';
		switch (fallbackStatus) {
			case 'connected': return 'codicon-check';
			case 'error': return 'codicon-error';
			default: return 'codicon-circle-large-outline';
		}
	}

	private formatProviderType(type: NeocodeSwarmProviderType): string {
		return type.charAt(0).toUpperCase() + type.slice(1);
	}

	private formatAuthMethod(method: NeocodeSwarmAuthMethod): string {
		switch (method) {
			case 'apiKey': return localize('neoSwarm.auth.apiKey', "API Key");
			case 'login': return localize('neoSwarm.auth.login', "Login");
			case 'cliToken': return localize('neoSwarm.auth.cli', "CLI");
			case 'qwen-oauth': return localize('neoSwarm.auth.qwenOAuth', "Qwen OAuth");
		}
	}

	private formatProviderStatus(status: NeocodeSwarmProviderStatus): string {
		switch (status) {
			case 'connected': return localize('neoSwarm.statusConnected', "Conectado");
			case 'error': return localize('neoSwarm.statusError', "Erro");
			default: return localize('neoSwarm.statusNotConfigured', "Nao configurado");
		}
	}
}

function hasUriScheme(value: string): boolean {
	return /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(value);
}

function isAbsoluteFilePath(value: string): boolean {
	return value.startsWith('/')
		|| /^([a-zA-Z]:[\\/]|\\\\)/.test(value);
}

function normalizeRelativePath(value: string): string {
	const normalized = value.replace(/\\/g, '/').trim();
	return normalized.startsWith('./') ? normalized.slice(2) : normalized;
}

function normalizeCapabilityPathInput(value: string): string {
	const trimmed = value.trim().replace(/\\/g, '/');
	if (!trimmed) {
		return '';
	}
	if (hasUriScheme(trimmed)) {
		return trimmed;
	}

	const lower = trimmed.toLowerCase();
	const marker = '/models/';
	const markerIndex = lower.indexOf(marker);
	if (markerIndex >= 0) {
		return trimmed.slice(markerIndex + 1);
	}

	return trimmed;
}

function getProcessCwd(): string | undefined {
	if (typeof process === 'undefined' || typeof process.cwd !== 'function') {
		return undefined;
	}
	try {
		const cwd = process.cwd();
		return cwd?.trim() || undefined;
	} catch {
		return undefined;
	}
}

function expandHomePath(value: string): string | undefined {
	const isHome = value === '~' || value.startsWith('~/');
	if (!isHome && !value.includes('${userHome}')) {
		return undefined;
	}

	const isProcessDefined = typeof process !== 'undefined';
	const home = isProcessDefined ? (process.env.HOME || process.env.USERPROFILE) : undefined;
	if (!home?.trim()) {
		return undefined;
	}

	const h = home.replace(/[\\/]+$/, '');
	if (value === '~') return h;
	if (value.startsWith('~/')) return `${h}/${value.slice(2)}`;

	return value.replace(/\$\{userHome\}/g, h);
}

function dedupeUris(values: URI[]): URI[] {
	const result: URI[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		const key = value.toString();
		if (!seen.has(key)) {
			seen.add(key);
			result.push(value);
		}
	}
	return result;
}

function getAncestorDirectories(startDir: string, maxDepth: number): string[] {
	const result: string[] = [];
	let current = startDir.trim().replace(/\\/g, '/').replace(/\/+$/, '');
	for (let i = 0; i <= maxDepth && current; i++) {
		result.push(current);
		const parent = dirnamePath(current);
		if (!parent || parent === current) {
			break;
		}
		current = parent;
	}
	return result;
}

function dirnamePath(value: string): string {
	const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
	if (!normalized) {
		return normalized;
	}

	if (normalized === '/') {
		return normalized;
	}

	const driveRootMatch = /^([a-zA-Z]:)$/.exec(normalized);
	if (driveRootMatch) {
		return `${driveRootMatch[1]}/`;
	}

	const index = normalized.lastIndexOf('/');
	if (index <= 0) {
		return index === 0 ? '/' : normalized;
	}
	return normalized.slice(0, index);
}

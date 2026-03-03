/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { IBoundarySashes } from '../../../../../base/browser/ui/sash/sash.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { IEditorOpenContext } from '../../../../common/editor.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { QwenAuthService } from './qwenAuthService.js';
import { IQwenConfigExport, IQwenProviderConfig, QwenAuthType, QwenProtocol } from '../common/qwenTypes.js';
import './media/qwenSettingsDialog.css';

type QwenTab = 'credentials' | 'cli' | 'diagnostics' | 'security';

export class QwenSettingsEditorInput extends EditorInput {
	static readonly ID = 'workbench.input.neocodeQwenSettings';
	override get typeId(): string { return QwenSettingsEditorInput.ID; }
	override getName(): string { return localize('neocode.qwen.editor.name', 'Configurar Qwen'); }
	override getIcon() { return Codicon.hubot; }
	override readonly resource = URI.from({ scheme: 'neocode-qwen', path: 'settings' });
	override matches(other: EditorInput): boolean { return other instanceof QwenSettingsEditorInput; }
}

export class QwenSettingsDialog extends EditorPane {
	static readonly ID = 'workbench.editors.neocodeQwenSettings';

	private readonly authService = this._register(this.instantiationService.createInstance(QwenAuthService));
	private config: IQwenProviderConfig = this.authService.loadConfig();
	private activeTab: QwenTab = 'credentials';
	private rootContainer: HTMLElement | undefined;
	private contentContainer: HTMLElement | undefined;
	private statusBar: HTMLElement | undefined;
	private cliOutput = '';

	constructor(
		group: IEditorGroup,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@INotificationService private readonly notificationService: INotificationService
	) {
		super(QwenSettingsDialog.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this.rootContainer = DOM.append(parent, DOM.$('.neocode-qwen-editor'));
		this.render();
	}

	override setBoundarySashes(_sashes: IBoundarySashes): void { }

	override layout(dimension: DOM.Dimension): void {
		const container = this.getContainer();
		if (container) {
			container.style.width = `${dimension.width}px`;
			container.style.height = `${dimension.height}px`;
		}
	}

	override async setInput(input: QwenSettingsEditorInput, options: any, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.config = this.authService.loadConfig();
		this.render();
	}

	private render(): void {
		if (!this.rootContainer) { return; }
		DOM.clearNode(this.rootContainer);
		const shell = DOM.append(this.rootContainer, DOM.$('.neocode-qwen-shell'));
		const tabs = DOM.append(shell, DOM.$('.neocode-qwen-tabs'));
		this.tabButton(tabs, 'credentials', localize('neocode.qwen.tab.credentials', 'Credenciais'), Codicon.key);
		this.tabButton(tabs, 'cli', localize('neocode.qwen.tab.cli', 'CLI'), Codicon.terminal);
		this.tabButton(tabs, 'diagnostics', localize('neocode.qwen.tab.diagnostics', 'Diagnostico'), Codicon.pulse);
		this.tabButton(tabs, 'security', localize('neocode.qwen.tab.security', 'Seguranca'), Codicon.shield);

		this.contentContainer = DOM.append(shell, DOM.$('.neocode-qwen-content'));
		this.statusBar = DOM.append(shell, DOM.$('.neocode-qwen-status'));
		this.renderActiveTab();
	}

	private tabButton(parent: HTMLElement, tab: QwenTab, label: string, icon: ThemeIcon): void {
		const button = DOM.append(parent, DOM.$('button.neocode-qwen-tab', { type: 'button' }));
		button.classList.toggle('active', this.activeTab === tab);
		DOM.append(button, DOM.$(`span${ThemeIcon.asCSSSelector(icon)}`));
		DOM.append(button, DOM.$('span', undefined, label));
		this._register(DOM.addDisposableListener(button, DOM.EventType.CLICK, () => {
			this.activeTab = tab;
			this.render();
		}));
	}

	private renderActiveTab(): void {
		if (!this.contentContainer) { return; }
		DOM.clearNode(this.contentContainer);
		switch (this.activeTab) {
			case 'credentials': return this.renderCredentialsTab(this.contentContainer);
			case 'cli': return this.renderCliTab(this.contentContainer);
			case 'diagnostics': return this.renderDiagnosticsTab(this.contentContainer);
			case 'security': return this.renderSecurityTab(this.contentContainer);
		}
	}

	private renderCredentialsTab(container: HTMLElement): void {
		DOM.append(container, DOM.$('h3', undefined, localize('neocode.qwen.credentials.title', 'Configurar Qwen')));
		const form = DOM.append(container, DOM.$('.neocode-qwen-form'));
		const credentials = this.authService.listCredentials();
		const activeCredential = credentials.find(credential => credential.id === this.config.activeCredentialId);
		const selectedCredentialId = activeCredential?.id ?? '__new__';
		const credentialSelect = this.selectField(form, 'Credencial', selectedCredentialId, [
			...credentials.map(credential => ({
				value: credential.id,
				label: `${credential.name} (${credential.authType})`,
			})),
			{ value: '__new__', label: 'Nova credencial...' },
		]);
		const credentialNameInput = this.inputField(form, 'Nome da credencial', activeCredential?.name ?? '');

		const authSelect = this.selectField(form, 'Auth Type', this.config.authType, [
			{ value: 'apiKey', label: 'API Key (Recomendado)' },
			{ value: 'qwen-oauth', label: 'Qwen OAuth (Assistido)' }
		]);
		const protocolSelect = this.selectField(form, 'Protocolo', this.config.protocol, [
			{ value: 'openai', label: 'OpenAI-compatible' },
			{ value: 'anthropic', label: 'Anthropic' },
			{ value: 'gemini', label: 'Gemini' },
			{ value: 'vertex-ai', label: 'Vertex AI' }
		]);
		const modelInput = this.inputField(form, 'Model ID', this.config.modelId);
		const displayInput = this.inputField(form, 'Display Name', this.config.displayName);
		const baseUrlInput = this.inputField(form, 'Base URL', this.config.baseUrl ?? '');
		const envInput = this.inputField(form, 'Nome da variavel de ambiente', this.config.envVarName);
		const cliPathInput = this.inputField(form, 'Caminho do executavel qwen (opcional)', this.config.cliPathOverride ?? '');
		let apiKeyInput: HTMLInputElement | undefined;

		if (authSelect.value === 'apiKey') {
			const row = DOM.append(form, DOM.$('.neocode-qwen-field'));
			DOM.append(row, DOM.$('label', undefined, 'API Key'));
			const group = DOM.append(row, DOM.$('.neocode-qwen-row-inline'));
			apiKeyInput = DOM.append(group, DOM.$('input.neocode-input', { type: 'password', placeholder: 'sk-...' })) as HTMLInputElement;
			const toggle = DOM.append(group, DOM.$('button.neocode-qwen-button', { type: 'button' }, localize('neocode.qwen.toggleSecret', 'Mostrar/Ocultar'))) as HTMLButtonElement;
			this._register(DOM.addDisposableListener(toggle, DOM.EventType.CLICK, () => {
				apiKeyInput!.type = apiKeyInput!.type === 'password' ? 'text' : 'password';
			}));
		}

		this._register(DOM.addDisposableListener(credentialSelect, DOM.EventType.CHANGE, async () => {
			const selectedId = credentialSelect.value;
			if (selectedId === '__new__') {
				credentialNameInput.value = '';
				return;
			}
			try {
				await this.authService.setActiveCredential(selectedId);
				this.config = this.authService.loadConfig();
				const selected = this.authService.listCredentials().find(credential => credential.id === selectedId);
				if (selected) {
					credentialNameInput.value = selected.name;
					authSelect.value = selected.authType;
				}
				this.render();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.setStatus(message, true);
			}
		}));

		const actions = DOM.append(container, DOM.$('.neocode-qwen-actions'));
		this.button(actions, localize('neocode.qwen.save', 'Salvar'), async () => {
			const selectedId = credentialSelect.value === '__new__' ? undefined : credentialSelect.value;
			const createNewCredential = credentialSelect.value === '__new__';
			const next: Partial<IQwenProviderConfig> = {
				authType: authSelect.value as QwenAuthType,
				protocol: protocolSelect.value as QwenProtocol,
				modelId: modelInput.value.trim(),
				displayName: displayInput.value.trim(),
				baseUrl: baseUrlInput.value.trim() || undefined,
				envVarName: envInput.value.trim(),
				cliPathOverride: cliPathInput.value.trim() || undefined
			};
			if (next.authType === 'apiKey') {
				const key = apiKeyInput?.value.trim();
				if (!key) {
					return this.setStatus('API key obrigatoria para auth API Key.', true);
				}
				await this.authService.saveApiKeyConfig({
					...next,
					apiKey: key,
					credentialId: selectedId,
					createNewCredential,
					credentialName: credentialNameInput.value.trim() || undefined,
				});
			} else {
				await this.authService.saveOAuthSelection(next);
				if (selectedId) {
					await this.authService.setActiveCredential(selectedId);
				}
			}
			this.config = this.authService.loadConfig();
			this.setStatus('Configuracao salva.');
			this.render();
		});

		this.button(actions, 'Remover credencial', async () => {
			const selectedId = credentialSelect.value === '__new__' ? undefined : credentialSelect.value;
			if (!selectedId) {
				return this.setStatus('Selecione uma credencial existente para remover.', true);
			}
			await this.authService.removeCredential(selectedId);
			this.config = this.authService.loadConfig();
			this.setStatus('Credencial removida.');
			this.render();
		});

		this.button(actions, localize('neocode.qwen.testConnection', 'Testar conexao'), async () => {
			const selectedId = credentialSelect.value === '__new__' ? undefined : credentialSelect.value;
			if (selectedId) {
				await this.authService.setActiveCredential(selectedId);
				this.config = this.authService.loadConfig();
			}
			const result = await this.authService.testApiKeyConnection();
			this.setStatus(result.message, !result.ok);
			this.config = this.authService.loadConfig();
		});

		// ── Qwen OAuth device flow area ──
		const oauthArea = DOM.append(container, DOM.$('.neocode-qwen-oauth-area'));
		const oauthStatus = DOM.append(oauthArea, DOM.$('.neocode-qwen-oauth-status'));
		const oauthActions = DOM.append(oauthArea, DOM.$('.neocode-qwen-actions'));

		const startBtn = this.button(oauthActions, localize('neocode.qwen.oauthLogin', 'Iniciar Login Nativo'), async () => {
			startBtn.disabled = true;
			cancelBtn.style.display = '';
			oauthStatus.textContent = '';
			const selectedId = credentialSelect.value === '__new__' ? undefined : credentialSelect.value;
			const createNewCredential = credentialSelect.value === '__new__';

			const result = await this.authService.startNativeOAuthFlow((msg: string) => {
				oauthStatus.textContent = `⏳ ${msg}`;
			}, {
				credentialId: selectedId,
				credentialName: credentialNameInput.value.trim() || undefined,
				createNewCredential,
				skipExistingCheck: createNewCredential,
			});

			startBtn.disabled = false;
			cancelBtn.style.display = 'none';

			if (result.ok) {
				oauthStatus.textContent = `✅ ${result.message}`;
				this.config = this.authService.loadConfig();
				this.setStatus(result.message);
			} else {
				oauthStatus.textContent = `❌ ${result.message}`;
				this.setStatus(result.message, true);
			}
		});

		const cancelBtn = this.button(oauthActions, localize('neocode.qwen.cancelOAuth', 'Cancelar'), () => {
			this.authService.cancelNativeOAuthFlow();
		});
		cancelBtn.style.display = 'none';

		this.button(actions, localize('neocode.qwen.clearCreds', 'Limpar credenciais'), async () => {
			await this.authService.clearAllQwenCredentials();
			this.setStatus('Credenciais removidas.');
		});
	}

	private renderCliTab(container: HTMLElement): void {
		DOM.append(container, DOM.$('h3', undefined, 'Qwen CLI'));
		const output = DOM.append(container, DOM.$('pre.neocode-qwen-output', undefined, this.cliOutput || 'Sem saida.'));
		const actions = DOM.append(container, DOM.$('.neocode-qwen-actions'));

		this.button(actions, 'Detectar novamente', async () => {
			const info = await this.authService.detectQwenCli();
			this.cliOutput = `${info.path} [${info.source}]\n${info.output ?? ''}`;
			output.textContent = this.cliOutput;
			this.setStatus(info.ok ? 'CLI detectado.' : 'CLI nao encontrado.', !info.ok);
		});
		this.button(actions, 'Testar qwen --version', async () => {
			const info = await this.authService.getQwenVersion();
			this.cliOutput = info.output ?? info.version ?? 'Sem saida';
			output.textContent = this.cliOutput;
			this.setStatus(info.ok ? `Versao: ${info.version ?? 'ok'}` : 'Falha ao obter versao.', !info.ok);
		});
		this.button(actions, 'Iniciar Fluxo OAuth', async () => {
			const result = await this.authService.startNativeOAuthFlow((msg: string) => {
				this.setStatus(msg, false);
			});
			this.setStatus(result.message, !result.ok);
		});
		this.button(actions, 'Validar CLI', async () => {
			const result = await this.authService.testApiKeyConnection();
			this.setStatus(result.message, !result.ok);
		});
	}

	private renderDiagnosticsTab(container: HTMLElement): void {
		DOM.append(container, DOM.$('h3', undefined, 'Diagnostico'));
		const block = DOM.append(container, DOM.$('pre.neocode-qwen-output'));
		block.textContent = 'Carregando diagnostico...';
		void this.authService.getDiagnostics().then(diagnostics => {
			block.textContent = JSON.stringify(diagnostics, null, 2);
		});

		const actions = DOM.append(container, DOM.$('.neocode-qwen-actions'));
		this.button(actions, 'Resetar estado de autenticacao quebrado', async () => {
			await this.authService.resetBrokenAuthState();
			this.setStatus('Estado de autenticacao resetado.');
			this.render();
		});
		this.button(actions, 'Executar diagnostico completo', async () => {
			const refreshed = await this.authService.getDiagnostics();
			block.textContent = JSON.stringify(refreshed, null, 2);
			this.setStatus('Diagnostico atualizado.');
		});
	}

	private renderSecurityTab(container: HTMLElement): void {
		DOM.append(container, DOM.$('h3', undefined, 'Seguranca'));
		DOM.append(container, DOM.$('p', undefined, 'As API keys sao armazenadas no cofre do sistema.'));
		DOM.append(container, DOM.$('p', undefined, 'O OAuth e gerenciado pelo proprio Qwen CLI.'));
		DOM.append(container, DOM.$('p', undefined, 'Nenhum segredo e salvo no settings do workspace.'));
		const actions = DOM.append(container, DOM.$('.neocode-qwen-actions'));

		this.button(actions, 'Apagar credenciais do NeoCode', async () => {
			await this.authService.clearAllQwenCredentials();
			this.setStatus('Credenciais apagadas.');
		});
		this.button(actions, 'Remover configuracao gerada do Qwen', async () => {
			await this.authService.removeGeneratedQwenConfig();
			this.setStatus('Configuracao gerada removida.');
		});
		this.button(actions, 'Limpar estado de autenticacao do Qwen', async () => {
			await this.authService.resetBrokenAuthState();
			this.setStatus('Estado de autenticacao limpo.');
		});
		this.button(actions, 'Exportar configuracao sem segredos', () => {
			const exported: IQwenConfigExport = this.authService.exportConfigWithoutSecrets();
			this.notificationService.info(JSON.stringify(exported, null, 2));
			this.setStatus('Configuracao exportada (sem segredos).');
		});
	}

	private inputField(parent: HTMLElement, label: string, value: string): HTMLInputElement {
		const row = DOM.append(parent, DOM.$('.neocode-qwen-field'));
		DOM.append(row, DOM.$('label', undefined, label));
		const input = DOM.append(row, DOM.$('input.neocode-input', { type: 'text' })) as HTMLInputElement;
		input.value = value;
		return input;
	}

	private selectField(parent: HTMLElement, label: string, value: string, options: { value: string; label: string }[]): HTMLSelectElement {
		const row = DOM.append(parent, DOM.$('.neocode-qwen-field'));
		DOM.append(row, DOM.$('label', undefined, label));
		const select = DOM.append(row, DOM.$('select.neocode-select')) as HTMLSelectElement;
		for (const option of options) {
			const el = DOM.append(select, DOM.$('option', { value: option.value }, option.label)) as HTMLOptionElement;
			el.selected = option.value === value;
		}
		return select;
	}

	private button(parent: HTMLElement, label: string, onClick: () => void): HTMLButtonElement {
		const button = DOM.append(parent, DOM.$('button.neocode-qwen-button', { type: 'button' }, label)) as HTMLButtonElement;
		this._register(DOM.addDisposableListener(button, DOM.EventType.CLICK, () => void onClick()));
		return button;
	}

	private setStatus(message: string, isError = false): void {
		if (this.statusBar) {
			this.statusBar.textContent = `Status: ${message}`;
			this.statusBar.classList.toggle('error', isError);
		}
		if (isError) {
			this.notificationService.error(message);
		}
	}
}

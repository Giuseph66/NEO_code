/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorOpenContext } from '../../../../common/editor.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { IBoundarySashes } from '../../../../../base/browser/ui/sash/sash.js';
import {
	IGeminiAuthService,
	IGeminiProviderConfig,
	IGeminiDiagnostics
} from '../common/geminiTypes.js';
import { maskSecret } from '../common/geminiConfigSchema.js';
import './media/geminiSettingsDialog.css';

type GeminiTab = 'googleLogin' | 'apiKey' | 'diagnostics';

export class GeminiSettingsEditorInput extends EditorInput {
	static readonly ID = 'workbench.input.neocodeGeminiSettings';

	override get typeId(): string {
		return GeminiSettingsEditorInput.ID;
	}

	override getName(): string {
		return localize('neocodeGeminiSettings', 'Configurar Gemini');
	}

	override getIcon(): ThemeIcon {
		return Codicon.sparkle;
	}

	override readonly resource = URI.from({ scheme: 'neocode-gemini', path: 'settings' });

	override matches(other: EditorInput): boolean {
		return other instanceof GeminiSettingsEditorInput;
	}
}

export class GeminiSettingsDialog extends EditorPane {
	static readonly ID = 'workbench.editors.neocodeGeminiSettings';

	private readonly tabDisposables = this._register(new DisposableStore());
	private config: IGeminiProviderConfig = this.geminiAuthService.loadConfig();
	private activeTab: GeminiTab = 'googleLogin';
	private contentContainer: HTMLElement | undefined;
	private tabButtons = new Map<GeminiTab, HTMLButtonElement>();
	private statusBar: HTMLElement | undefined;
	// Draft secrets — not stored until user clicks Save
	private apiKeyDraft = '';

	constructor(
		group: IEditorGroup,
		@IInstantiationService _instantiationService: IInstantiationService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IDialogService private readonly dialogService: IDialogService,
		@INotificationService _notificationService: INotificationService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IGeminiAuthService private readonly geminiAuthService: IGeminiAuthService,
	) {
		super(GeminiSettingsDialog.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		const container = DOM.append(parent, DOM.$('.neocode-gemini-editor'));
		this.renderBody(container);
	}

	override layout(dimension: DOM.Dimension): void {
		const container = this.getContainer();
		if (container) {
			container.style.width = `${dimension.width}px`;
			container.style.height = `${dimension.height}px`;
		}
	}

	override setBoundarySashes(_sashes: IBoundarySashes): void { /* no-op */ }

	override async setInput(input: GeminiSettingsEditorInput, options: any, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.config = this.geminiAuthService.loadConfig();
		this.renderActiveTab();
	}

	// ─── Shell ─────────────────────────────────────────────────────────────────

	private renderBody(container: HTMLElement): void {
		const shell = DOM.append(container, DOM.$('.neocode-gemini-shell'));
		const nav = DOM.append(shell, DOM.$('.neocode-gemini-nav'));
		const main = DOM.append(shell, DOM.$('.neocode-gemini-main'));

		const navTabs = DOM.append(nav, DOM.$('.neocode-gemini-tabs', { role: 'tablist' }));
		this.tabButtons.set('googleLogin', this.createTabButton(navTabs, 'googleLogin', localize('gemini.tab.googleLogin', 'Login com Google'), Codicon.account));
		this.tabButtons.set('apiKey', this.createTabButton(navTabs, 'apiKey', localize('gemini.tab.apiKey', 'API Key'), Codicon.key));
		this.tabButtons.set('diagnostics', this.createTabButton(navTabs, 'diagnostics', localize('gemini.tab.diagnostics', 'Diagnostico'), Codicon.bug));

		this.contentContainer = DOM.append(main, DOM.$('.neocode-gemini-content'));
		this.statusBar = DOM.append(main, DOM.$('.neocode-gemini-status'));
	}

	private createTabButton(parent: HTMLElement, tab: GeminiTab, label: string, icon?: ThemeIcon): HTMLButtonElement {
		const button = DOM.append(parent, DOM.$('button.neocode-gemini-tab', { type: 'button', role: 'tab' })) as HTMLButtonElement;
		if (icon) {
			DOM.append(button, DOM.$(`span${ThemeIcon.asCSSSelector(icon)}`));
		}
		DOM.append(button, DOM.$('span.tab-label', undefined, label));
		this._register(DOM.addDisposableListener(button, DOM.EventType.CLICK, () => {
			this.activeTab = tab;
			this.renderActiveTab();
		}));
		return button;
	}

	private renderActiveTab(): void {
		if (!this.contentContainer) { return; }
		this.tabDisposables.clear();
		DOM.clearNode(this.contentContainer);
		for (const [tabId, button] of this.tabButtons.entries()) {
			button.classList.toggle('active', tabId === this.activeTab);
			button.setAttribute('aria-selected', tabId === this.activeTab ? 'true' : 'false');
		}
		switch (this.activeTab) {
			case 'googleLogin': void this.renderGoogleLoginTab(this.contentContainer); break;
			case 'apiKey': this.renderApiKeyTab(this.contentContainer); break;
			case 'diagnostics': void this.renderDiagnosticsTab(this.contentContainer); break;
		}
	}

	// ─── Tab 1 — Google Login ──────────────────────────────────────────────────

	private async renderGoogleLoginTab(container: HTMLElement): Promise<void> {
		const card = DOM.append(container, DOM.$('.neocode-card'));
		DOM.append(card, DOM.$('h2', undefined, localize('gemini.login.title', 'Autenticacao Google')));
		DOM.append(card, DOM.$('p', undefined, localize('gemini.login.subtitle', 'Use sua conta Google para acessar o Gemini de forma nativa e segura.')));

		const loadingEl = DOM.append(card, DOM.$('.neocode-note', undefined, localize('gemini.login.loading', 'Verificando estado...')));

		let diag: IGeminiDiagnostics;
		try {
			diag = await this.geminiAuthService.getDiagnostics();
		} catch (error) {
			loadingEl.remove();
			DOM.append(card, DOM.$('.neocode-error', undefined, localize('gemini.login.error', 'Erro ao obter estado de login: {0}', String(error))));
			return;
		}
		loadingEl.remove();

		if (diag.hasOAuthTokens) {
			const infoBox = DOM.append(card, DOM.$('.neocode-info-box.glass'));
			const userRow = DOM.append(infoBox, DOM.$('.neocode-user-profile-row'));
			DOM.append(userRow, DOM.$('span.codicon.codicon-account', { style: 'font-size: 24px; margin-right: 12px;' }));
			const details = DOM.append(userRow, DOM.$('.neocode-user-details'));
			DOM.append(details, DOM.$('strong', undefined, localize('gemini.login.loggedInAs', 'Logado como:')));
			DOM.append(details, DOM.$('span.neocode-user-email', undefined, diag.email ?? localize('gemini.login.emailUnknown', 'Email desconhecido')));

			if (this.config.authType !== 'googleLogin') {
				const promo = DOM.append(card, DOM.$('.neocode-note.info', undefined, localize('gemini.login.promo', 'O Login com Google esta configurado mas nao esta selecionado como metodo principal.')));
				this.appendButton(promo, localize('gemini.login.selectMethod', 'Usar este metodo'), async () => {
					this.config.authType = 'googleLogin';
					await this.geminiAuthService.saveGoogleLoginPreference(this.config);
					this.renderActiveTab();
				}).classList.add('small');
			}

			const form = DOM.append(card, DOM.$('.neocode-form-grid'));
			this.appendLabeledInput(form, localize('gemini.method.model', 'Modelo Gemini'), this.config.modelName, value => {
				this.config.modelName = value.trim() || 'gemini-2.5-pro';
			});
			this.appendLabeledInput(form, localize('gemini.login.project', 'Google Cloud Project ID (opcional)'), this.config.googleCloudProject ?? '', value => {
				this.config.googleCloudProject = value.trim() || undefined;
			});

			const actions = DOM.append(card, DOM.$('.neocode-actions-row'));
			const saveBtn = this.appendButton(actions, localize('gemini.login.saveSettings', 'Salvar Alteracoes'), async () => {
				await this.geminiAuthService.saveGoogleLoginPreference(this.config);
				this.updateStatus(localize('gemini.saved', 'Configuracao salva.'));
			});
			saveBtn.classList.add('primary');

			this.appendButton(actions, localize('gemini.login.testSession', 'Testar Conexao'), async () => {
				this.updateStatus(localize('gemini.testing', 'Testando...'));
				const result = await this.geminiAuthService.testGoogleLoginConnection();
				this.updateStatus(result.message, !result.ok);
			});

			this.appendButton(actions, localize('gemini.login.logout', 'Sair'), async () => {
				const confirmed = await this.dialogService.confirm({
					type: 'warning',
					message: localize('gemini.login.logoutTitle', 'Encerrar sessao?'),
					detail: localize('gemini.login.logoutDetail', 'Isso removera os tokens de acesso atuais do seu cofre.'),
					primaryButton: localize('gemini.login.logoutConfirm', 'Sair')
				});
				if (confirmed.confirmed) {
					await this.geminiAuthService.clearAllGeminiCredentials();
					this.updateStatus(localize('gemini.login.loggedOut', 'Sessao encerrada.'));
					this.renderActiveTab();
				}
			});
		} else {
			DOM.append(card, DOM.$('.neocode-note', undefined, localize(
				'gemini.login.note',
				'Este fluxo abre o navegador do sistema de forma segura. Nenhum terminal externo e necessario.'
			)));

			const actions = DOM.append(card, DOM.$('.neocode-actions-row'));
			const loginBtn = this.appendButton(actions, localize('gemini.login.start', 'Conectar com Google'), async () => {
				this.updateStatus(localize('gemini.login.starting', 'Aguardando autenticacao. Conclua no navegador aberto...'));
				const result = await this.geminiAuthService.startNativeGoogleLoginFlow();
				this.updateStatus(result.message, !result.ok);
				if (result.ok) {
					this.renderActiveTab();
				}
			});
			loginBtn.classList.add('primary');
		}
	}

	// ─── Tab 2 — API Key ───────────────────────────────────────────────────────

	private renderApiKeyTab(container: HTMLElement): void {
		const card = DOM.append(container, DOM.$('.neocode-card'));
		DOM.append(card, DOM.$('h2', undefined, localize('gemini.apiKey.title', 'Gemini API Key')));
		DOM.append(card, DOM.$('p', undefined, localize('gemini.apiKey.subtitle', 'Configure uma chave de API do Google AI Studio.')));

		if (this.config.authType === 'googleLogin') {
			const note = DOM.append(card, DOM.$('.neocode-note.info', undefined, localize('gemini.apiKey.usingLogin', 'Voce esta usando Login com Google. A API Key configurada aqui so sera usada se voce mudar o metodo principal.')));
			this.appendButton(note, localize('gemini.apiKey.useKey', 'Usar API Key como principal'), async () => {
				this.config.authType = 'apiKey';
				await this.geminiAuthService.saveGoogleLoginPreference(this.config);
				this.renderActiveTab();
			}).classList.add('small');
		}

		const form = DOM.append(card, DOM.$('.neocode-form-grid'));

		const varNote = DOM.append(form, DOM.$('.neocode-field-block'));
		DOM.append(varNote, DOM.$('label', undefined, localize('gemini.apiKey.varLabel', 'Variavel de ambiente')));
		const varRow = DOM.append(varNote, DOM.$('.neocode-radio-row'));
		this.appendRadio(varRow, 'geminiApiKeyVar', 'GEMINI_API_KEY',
			'GEMINI_API_KEY',
			this.config.apiKeyVar === 'GEMINI_API_KEY',
			() => { this.config.apiKeyVar = 'GEMINI_API_KEY'; });
		this.appendRadio(varRow, 'geminiApiKeyVar', 'GOOGLE_API_KEY',
			'GOOGLE_API_KEY',
			this.config.apiKeyVar === 'GOOGLE_API_KEY',
			() => { this.config.apiKeyVar = 'GOOGLE_API_KEY'; });

		this.appendLabeledInput(form, localize('gemini.method.model', 'Modelo Gemini'), this.config.modelName, value => {
			this.config.modelName = value.trim() || 'gemini-2.5-pro';
		});

		const keyRow = DOM.append(form, DOM.$('.neocode-inline-field-row'));
		const keyInput = DOM.append(keyRow, DOM.$('input.neocode-input', {
			type: 'password',
			placeholder: this.apiKeyDraft ? maskSecret(this.apiKeyDraft) : 'AIza...'
		})) as HTMLInputElement;
		keyInput.value = this.apiKeyDraft;
		this.tabDisposables.add(DOM.addDisposableListener(keyInput, DOM.EventType.INPUT, () => {
			this.apiKeyDraft = keyInput.value;
		}));
		this.appendButton(keyRow, localize('gemini.showHide', 'Ver'), () => {
			keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
		});

		const actions = DOM.append(card, DOM.$('.neocode-actions-row'));
		const saveBtn = this.appendButton(actions, localize('gemini.apiKey.save', 'Salvar Alteracoes'), async () => {
			const key = this.apiKeyDraft.trim();
			if (key) {
				await this.geminiAuthService.saveApiKeyConfig({ ...this.config, apiKey: key });
				this.apiKeyDraft = '';
				keyInput.value = '';
				keyInput.placeholder = maskSecret(key);
			} else {
				await this.geminiAuthService.saveGoogleLoginPreference(this.config);
			}
			this.updateStatus(localize('gemini.saved', 'Configuracao salva.'));
		});
		saveBtn.classList.add('primary');

		this.appendButton(actions, localize('gemini.apiKey.testSdk', 'Testar Conexao'), async () => {
			this.updateStatus(localize('gemini.testing', 'Testando...'));
			const result = await this.geminiAuthService.testApiKeyConnection();
			this.updateStatus(result.message, !result.ok);
		});

		const link = DOM.$('a.neocode-link', { href: 'https://aistudio.google.com/apikey', target: '_blank' }, localize('gemini.apiKey.getStudio', 'Obter chave no Google AI Studio'));
		DOM.append(card, DOM.$('.neocode-link-row', undefined, link));
		this.tabDisposables.add(DOM.addDisposableListener(link, DOM.EventType.CLICK, e => {
			e.preventDefault();
			void this.openerService.open(URI.parse('https://aistudio.google.com/apikey'));
		}));
	}

	// ─── Tab 3 — Diagnostics ───────────────────────────────────────────────────

	private async renderDiagnosticsTab(container: HTMLElement): Promise<void> {
		const card = DOM.append(container, DOM.$('.neocode-card'));
		DOM.append(card, DOM.$('h2', undefined, localize('gemini.diag.title', 'Diagnostico de Conexao')));

		const loadingEl = DOM.append(card, DOM.$('.neocode-note', undefined, localize('gemini.diag.loading', 'Carregando...')));

		let diag: IGeminiDiagnostics;
		try {
			diag = await this.geminiAuthService.getDiagnostics();
		} catch (error) {
			DOM.clearNode(card);
			DOM.append(card, DOM.$('.neocode-error', undefined, localize('gemini.diag.error', 'Erro: {0}', String(error))));
			return;
		}
		loadingEl.remove();

		const grid = DOM.append(card, DOM.$('.neocode-form-grid'));

		const row = (label: string, value: string): void => {
			const block = DOM.append(grid, DOM.$('.neocode-field-block'));
			DOM.append(block, DOM.$('label', undefined, label));
			DOM.append(block, DOM.$('span.neocode-diag-value', undefined, value));
		};

		row(localize('gemini.diag.authMethod', 'Metodo Principal'), diag.authType);
		row(localize('gemini.diag.model', 'Modelo'), diag.modelName);
		if (diag.email) {
			row(localize('gemini.diag.email', 'Email (Google)'), diag.email);
		}
		row('GEMINI_API_KEY', diag.hasGeminiApiKey ? '✅' : '—');
		row('GOOGLE_API_KEY', diag.hasGoogleApiKey ? '✅' : '—');
		row('OAuth Tokens', diag.hasOAuthTokens ? '✅' : '—');

		if (diag.conflicts.length > 0 || diag.issues.length > 0) {
			const box = DOM.append(card, DOM.$('.neocode-warning-box'));
			[...diag.conflicts, ...diag.issues].forEach(msg => {
				DOM.append(box, DOM.$('p.neocode-warning', undefined, `⚠ ${msg}`));
			});
		}

		const actions = DOM.append(card, DOM.$('.neocode-actions-row'));
		this.appendButton(actions, localize('gemini.diag.redetect', 'Atualizar'), () => { this.renderActiveTab(); });

		this.appendButton(actions, localize('gemini.diag.clearCredentials', 'Limpar Tudo'), async () => {
			const confirmed = await this.dialogService.confirm({
				type: 'warning',
				title: localize('gemini.diag.clearCredsTitle', 'Limpar credenciais?'),
				message: localize('gemini.diag.clearCredsDetail', 'Isso removera todas as chaves e tokens salvos.'),
				primaryButton: localize('gemini.diag.clearCredsConfirm', 'Limpar')
			});
			if (confirmed.confirmed) {
				await this.geminiAuthService.clearAllGeminiCredentials();
				this.renderActiveTab();
			}
		}).classList.add('danger');
	}

	// ─── DOM helpers ───────────────────────────────────────────────────────────

	private appendButton(parent: HTMLElement, label: string, handler: () => void): HTMLButtonElement {
		const button = DOM.append(parent, DOM.$('button.neocode-button', { type: 'button' }, label)) as HTMLButtonElement;
		this.tabDisposables.add(DOM.addDisposableListener(button, DOM.EventType.CLICK, handler));
		return button;
	}



	private appendLabeledInput(parent: HTMLElement, label: string, currentValue: string, onChange: (value: string) => void): void {
		const block = DOM.append(parent, DOM.$('.neocode-field-block'));
		DOM.append(block, DOM.$('label', undefined, label));
		const input = DOM.append(block, DOM.$('input.neocode-input', { type: 'text', value: currentValue })) as HTMLInputElement;
		this.tabDisposables.add(DOM.addDisposableListener(input, DOM.EventType.INPUT, () => onChange(input.value)));
	}

	private appendRadio(
		parent: HTMLElement,
		name: string,
		value: string,
		label: string,
		checked: boolean,
		onChange: () => void
	): void {
		const row = DOM.append(parent, DOM.$('.neocode-radio-item'));
		const radio = DOM.append(row, DOM.$('input', { type: 'radio', name, value })) as HTMLInputElement;
		radio.checked = checked;
		DOM.append(row, DOM.$('label', undefined, label));
		this.tabDisposables.add(DOM.addDisposableListener(radio, DOM.EventType.CHANGE, () => {
			if (radio.checked) { onChange(); }
		}));
	}

	private updateStatus(message: string, isError = false): void {
		if (!this.statusBar) { return; }
		this.statusBar.textContent = message;
		this.statusBar.classList.toggle('error', isError);
		this.statusBar.classList.toggle('ok', !isError);
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { buildQwenDiagnostics } from './qwenDiagnostics.js';
import { QwenCliBridge } from './qwenCliBridge.js';
import { QwenOAuthDeviceFlowController, IQwenDeviceFlowProgress, IQwenOAuthCredentials } from './qwenOAuthDeviceFlowController.js';
import { QwenConfigWriter } from './qwenConfigWriter.js';
import { QwenRuntimeAdapter } from './qwenRuntimeAdapter.js';
import { createDefaultQwenProviderConfig, protocolDefaultEnvVar, sanitizeQwenError, toExportConfig } from '../common/qwenConfigSchema.js';
import {
	IQwenAuthService,
	IQwenCliInfo,
	IQwenConfigExport,
	IQwenConnectionTestResult,
	IQwenDiagnostics,
	IQwenProviderConfig,
	IQwenRuntimeEnvResult,
	IQwenStoredCredential,
	IQwenOAuthStartOptions,
	NEO_QWEN_SECRET_API_KEY,
	NEO_QWEN_SECRET_API_KEY_PREFIX,
	NEO_QWEN_SECRET_OAUTH_CREDENTIAL_PREFIX,
	NEO_QWEN_STORAGE_KEY
} from '../common/qwenTypes.js';

export class QwenAuthService extends Disposable implements IQwenAuthService {
	declare readonly _serviceBrand: undefined;

	private readonly cliBridge: QwenCliBridge;
	private readonly configWriter: QwenConfigWriter;
	private readonly runtimeAdapter: QwenRuntimeAdapter;

	constructor(
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@IStorageService private readonly storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IDialogService private readonly dialogService: IDialogService,
		@ILogService private readonly logService: ILogService,
		@IFileService private readonly fileService: IFileService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IPathService private readonly pathService: IPathService,
	) {
		super();
		this.cliBridge = this._register(this.instantiationService.createInstance(QwenCliBridge));
		this.configWriter = this.instantiationService.createInstance(QwenConfigWriter);
		this.runtimeAdapter = this._register(this.instantiationService.createInstance(QwenRuntimeAdapter));
	}

	loadConfig(): IQwenProviderConfig {
		const fallback = createDefaultQwenProviderConfig();
		const raw = this.storageService.get(NEO_QWEN_STORAGE_KEY, StorageScope.PROFILE);
		if (!raw) {
			return fallback;
		}
		try {
			const parsed = JSON.parse(raw) as Partial<IQwenProviderConfig>;
			const protocol = parsed.protocol ?? fallback.protocol;
			return this.normalizeConfig({
				...fallback,
				...parsed,
				envVarName: parsed.envVarName || protocolDefaultEnvVar(protocol),
			});
		} catch {
			return fallback;
		}
	}

	async saveApiKeyConfig(config: Partial<IQwenProviderConfig> & { apiKey: string; credentialId?: string; credentialName?: string; createNewCredential?: boolean }): Promise<void> {
		const current = this.loadConfig();
		const now = Date.now();
		const next: IQwenProviderConfig = {
			...current,
			...config,
			authType: 'apiKey',
			envVarName: config.envVarName || protocolDefaultEnvVar(config.protocol ?? current.protocol),
		};
		const credentials = [...(next.credentials ?? [])];
		const targetCredentialId = this.resolveTargetCredentialId(credentials, 'apiKey', {
			credentialId: config.credentialId,
			createNewCredential: config.createNewCredential,
			activeCredentialId: next.activeCredentialId,
		});
		const existing = credentials.find(credential => credential.id === targetCredentialId);
		const credentialName = config.credentialName?.trim()
			|| existing?.name
			|| `Qwen API Key ${new Date(now).toLocaleString()}`;
		const updatedCredential: IQwenStoredCredential = {
			id: targetCredentialId,
			name: credentialName,
			authType: 'apiKey',
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
			lastUsedAt: existing?.lastUsedAt,
		};
		this.upsertCredential(credentials, updatedCredential);
		next.credentials = credentials;
		next.activeCredentialId = targetCredentialId;

		await this.secretStorageService.set(this.apiKeySecretForCredential(targetCredentialId), config.apiKey.trim());
		// Backward compatibility with previous single-key storage.
		await this.secretStorageService.set(NEO_QWEN_SECRET_API_KEY, config.apiKey.trim());

		this.storeConfig(next);
		await this.syncQwenConfig();
	}

	async saveOAuthSelection(config: Partial<IQwenProviderConfig>): Promise<void> {
		const current = this.loadConfig();
		const next: IQwenProviderConfig = {
			...current,
			...config,
			authType: 'qwen-oauth',
			envVarName: config.envVarName || protocolDefaultEnvVar(config.protocol ?? current.protocol),
		};
		this.storeConfig(next);
		await this.syncQwenConfig();
	}

	async testApiKeyConnection(): Promise<IQwenConnectionTestResult> {
		try {
			const config = this.loadConfig();
			const env = await this.buildRuntimeEnv();
			const result = await this.runtimeAdapter.testConnection(config, env);
			this.storeConfig({ ...config, lastConnectionStatus: result.ok ? 'connected' : 'error', lastConnectionMessage: result.message, lastConnectionAt: Date.now() });
			return result;
		} catch (error) {
			// SDK unavailable — fall back to file-based OAuth credential check.
			const oauthFallback = await this.checkOAuthCredsFile();
			if (oauthFallback) {
				const config = this.loadConfig();
				this.storeConfig({ ...config, lastConnectionStatus: oauthFallback.ok ? 'connected' : 'error', lastConnectionMessage: oauthFallback.message, lastConnectionAt: Date.now() });
				return oauthFallback;
			}
			const message = sanitizeQwenError(error instanceof Error ? error.message : String(error));
			const config = this.loadConfig();
			this.storeConfig({ ...config, lastConnectionStatus: 'error', lastConnectionMessage: message, lastConnectionAt: Date.now() });
			return { ok: false, kind: 'unknown_error', message };
		}
	}

	/**
	 * Reads ~/.qwen/oauth_creds.json directly to detect whether the user has
	 * valid OAuth credentials without needing the Qwen SDK.
	 */
	private async checkOAuthCredsFile(): Promise<IQwenConnectionTestResult | undefined> {
		try {
			const userHomeUri = await this.pathService.userHome();
			const credsUri = URI.joinPath(userHomeUri, '.qwen', 'oauth_creds.json');
			const content = await this.fileService.readFile(credsUri);
			const text = content.value.toString();
			if (!text.trim()) {
				return undefined;
			}
			const creds = JSON.parse(text) as { access_token?: string; expiry_date?: number; token_type?: string };
			if (!creds.access_token?.trim()) {
				return { ok: false, kind: 'auth_required', message: localize('neocode.qwen.oauth.noToken', 'OAuth creds encontrado mas sem access_token. Refaca o login.') };
			}
			if (creds.expiry_date && creds.expiry_date < Date.now()) {
				return { ok: false, kind: 'auth_required', message: localize('neocode.qwen.oauth.expired', 'Token OAuth expirado em {0}. Refaca o login.', new Date(creds.expiry_date).toLocaleString()) };
			}
			const expiresInfo = creds.expiry_date
				? localize('neocode.qwen.oauth.expiresAt', ' Expira em {0}.', new Date(creds.expiry_date).toLocaleString())
				: '';
			return {
				ok: true,
				kind: 'connected',
				message: localize('neocode.qwen.oauth.connected', 'Qwen OAuth conectado (credenciais em ~/.qwen/).{0}', expiresInfo)
			};
		} catch {
			// File doesn't exist or can't be read — no fallback available
			return undefined;
		}
	}

	private _activeDeviceFlowController?: QwenOAuthDeviceFlowController;

	async startNativeOAuthFlow(onProgress?: (msg: string) => void, options?: IQwenOAuthStartOptions): Promise<IQwenConnectionTestResult> {
		const config = this.loadConfig();
		let controller: QwenOAuthDeviceFlowController | undefined;
		try {
			const skipExistingCheck = options?.skipExistingCheck ?? options?.createNewCredential ?? false;
			if (!skipExistingCheck) {
				if (onProgress) {
					onProgress(localize('neocode.qwen.oauth.checking', 'Verificando credenciais OAuth existentes...'));
				}

				const existing = await this.checkOAuthCredsFile();
				if (existing?.ok) {
					const existingCreds = await this.readOAuthCredsFromFile();
					if (existingCreds) {
						await this.saveOAuthCredentialMetadata(config, existingCreds, options);
					}
					this.storeConfig({ ...this.loadConfig(), authType: 'qwen-oauth', lastConnectionStatus: 'connected', lastConnectionMessage: existing.message });
					return existing;
				}
			}

			// Run the device code flow natively
			controller = new QwenOAuthDeviceFlowController(this.instantiationService, this.fileService, this.openerService, this.pathService);
			this._activeDeviceFlowController = controller;

			const result = await controller.startDeviceFlow((progress: IQwenDeviceFlowProgress) => {
				if (onProgress) {
					onProgress(progress.message);
				}
			});

			if (result.ok) {
				if (result.credentials) {
					await this.saveOAuthCredentialMetadata(config, result.credentials, options);
				}
				this.storeConfig({
					...this.loadConfig(),
					authType: 'qwen-oauth',
					lastConnectionStatus: 'connected',
					lastConnectionMessage: result.message,
					lastConnectionAt: Date.now(),
				});
				return {
					ok: true,
					kind: 'connected',
					message: result.message,
				};
			}

			return {
				ok: false,
				kind: 'auth_required',
				message: result.message,
			};
		} catch (e: unknown) {
			const message = e instanceof Error ? e.message : String(e);
			return { ok: false, kind: 'unknown_error', message };
		} finally {
			if (this._activeDeviceFlowController === controller) {
				this._activeDeviceFlowController = undefined;
			}
			controller?.dispose();
		}
	}

	cancelNativeOAuthFlow(): void {
		this._activeDeviceFlowController?.cancel();
		this._activeDeviceFlowController?.dispose();
		this._activeDeviceFlowController = undefined;
	}

	listCredentials(): IQwenStoredCredential[] {
		return [...(this.loadConfig().credentials ?? [])]
			.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
	}

	async setActiveCredential(credentialId: string): Promise<void> {
		const current = this.loadConfig();
		const credentials = [...(current.credentials ?? [])];
		const found = credentials.find(credential => credential.id === credentialId);
		if (!found) {
			throw new Error(localize('neocode.qwen.credential.notFound', 'Credencial selecionada nao encontrada.'));
		}
		found.lastUsedAt = Date.now();
		this.upsertCredential(credentials, found);
		this.storeConfig({
			...current,
			credentials,
			activeCredentialId: credentialId,
			authType: found.authType,
		});
		await this.syncQwenConfig();
	}

	async removeCredential(credentialId: string): Promise<void> {
		const current = this.loadConfig();
		const credentials = [...(current.credentials ?? [])];
		const filtered = credentials.filter(credential => credential.id !== credentialId);
		if (filtered.length === credentials.length) {
			return;
		}
		await this.secretStorageService.delete(this.apiKeySecretForCredential(credentialId));
		await this.secretStorageService.delete(this.oauthSecretForCredential(credentialId));

		let nextActive = current.activeCredentialId;
		if (nextActive === credentialId) {
			nextActive = filtered[0]?.id;
		}
		const activeCredential = filtered.find(credential => credential.id === nextActive);
		this.storeConfig({
			...current,
			credentials: filtered,
			activeCredentialId: nextActive,
			authType: activeCredential?.authType ?? current.authType,
		});
		await this.syncQwenConfig();
	}

	async detectQwenCli(): Promise<IQwenCliInfo> {
		const config = this.loadConfig();
		return this.cliBridge.detectQwenCli(config.cliPathOverride);
	}

	async getQwenVersion(): Promise<IQwenCliInfo> {
		const config = this.loadConfig();
		return this.cliBridge.detectQwenCli(config.cliPathOverride);
	}

	async resetBrokenAuthState(): Promise<void> {
		const confirmation = await this.dialogService.confirm({
			type: 'warning',
			message: localize('neocode.qwen.resetBrokenAuth.title', 'Resetar estado de autenticacao do Qwen?'),
			detail: localize('neocode.qwen.resetBrokenAuth.detail', 'Isso remove security.auth.selectedType dos arquivos settings do Qwen, preservando o restante.'),
			primaryButton: localize('neocode.qwen.resetBrokenAuth.confirm', 'Resetar')
		});
		if (!confirmation.confirmed) {
			return;
		}
		await this.configWriter.resetBrokenAuthState();
	}

	async clearAllQwenCredentials(): Promise<void> {
		const current = this.loadConfig();
		await this.secretStorageService.delete(NEO_QWEN_SECRET_API_KEY);
		for (const credential of current.credentials ?? []) {
			await this.secretStorageService.delete(this.apiKeySecretForCredential(credential.id));
			await this.secretStorageService.delete(this.oauthSecretForCredential(credential.id));
		}
		await this.clearOAuthCredentialFiles();
		this._activeDeviceFlowController?.cancel();
		this._activeDeviceFlowController?.dispose();
		this._activeDeviceFlowController = undefined;
		this.storeConfig({
			...current,
			credentials: [],
			activeCredentialId: undefined,
			lastConnectionStatus: 'unknown',
			lastConnectionMessage: 'Credenciais removidas.',
		});
		await this.syncQwenConfig();
	}

	private async clearOAuthCredentialFiles(): Promise<void> {
		try {
			const userHomeUri = await this.pathService.userHome();
			const credsUri = URI.joinPath(userHomeUri, '.qwen', 'oauth_creds.json');
			const lockUri = URI.joinPath(userHomeUri, '.qwen', 'oauth_creds.lock');
			try { await this.fileService.del(credsUri); } catch { /* ignore */ }
			try { await this.fileService.del(lockUri); } catch { /* ignore */ }
		} catch {
			// Ignore cleanup issues to avoid blocking auth reset.
		}
	}

	async buildRuntimeEnv(): Promise<IQwenRuntimeEnvResult> {
		const config = this.loadConfig();
		const env: Record<string, string> = {};
		const activeCredential = this.getActiveCredential(config);

		if (config.authType === 'apiKey') {
			let apiKey = activeCredential && activeCredential.authType === 'apiKey'
				? (await this.secretStorageService.get(this.apiKeySecretForCredential(activeCredential.id)))?.trim()
				: undefined;
			if (!apiKey) {
				apiKey = (await this.secretStorageService.get(NEO_QWEN_SECRET_API_KEY))?.trim();
			}
			if (apiKey) {
				env[config.envVarName] = apiKey;
			}
		}

		// OAuth: first try active credential snapshot, then fallback to ~/.qwen/oauth_creds.json
		if (config.authType === 'qwen-oauth' && !env[config.envVarName]) {
			let refreshFailure: Error | undefined;
			let creds = activeCredential?.authType === 'qwen-oauth'
				? await this.readOAuthCredentialFromSecret(activeCredential.id)
				: undefined;
			if (!creds) {
				creds = await this.readOAuthCredsFromFile();
			}
			try {
				if (creds?.access_token && creds.refresh_token && creds.expiry_date) {
					const now = Date.now();
					// Expired or expiring in < 5 mins
					if (now + 5 * 60 * 1000 > creds.expiry_date) {
						this.logService.info('[neocode qwen auth] Token expired or expiring soon, attempting refresh...');
						const controller = new QwenOAuthDeviceFlowController(this.instantiationService, this.fileService, this.openerService, this.pathService);
						try {
							// Pass the existing resource_url so it is preserved when the
							// refresh response does not include one (preventing 401 errors
							// caused by falling back to the wrong DashScope endpoint).
							const result = await controller.refreshAccessToken(creds.refresh_token, creds.resource_url);

							if (result.ok && result.credentials) {
								creds = result.credentials;
								this.logService.info('[neocode qwen auth] Token refreshed successfully.');
							} else {
								const canKeepUsingCurrentToken =
									!!creds.access_token?.trim() &&
									typeof creds.expiry_date === 'number' &&
									creds.expiry_date > now + 30 * 1000;

								if (canKeepUsingCurrentToken) {
									this.logService.warn('[neocode qwen auth] Token refresh failed, but current token is still valid. Continuing with cached token.');
								} else {
									const message = result.message || localize('neocode.qwen.oauth.refreshFailed', 'Falha ao atualizar token. Por favor, autentique-se novamente.');
									this.logService.error('[neocode qwen auth] Token refresh failed:', message);
									await this.clearOAuthCredentialFiles();
									if (activeCredential?.authType === 'qwen-oauth') {
										await this.secretStorageService.delete(this.oauthSecretForCredential(activeCredential.id));
									}
									refreshFailure = new Error(message);
								}
							}
						} finally {
							controller.dispose();
						}
					}
				}

				if (creds?.resource_url?.trim()) {
					env['QWEN_OAUTH_RESOURCE_URL'] = creds.resource_url.trim();
				}

				if (creds?.access_token?.trim() && !refreshFailure) {
					env[config.envVarName] = creds.access_token.trim();
					if (activeCredential?.authType === 'qwen-oauth') {
						await this.secretStorageService.set(this.oauthSecretForCredential(activeCredential.id), JSON.stringify(creds));
					}
				}
			} catch (error) {
				// OAuth creds not found or unreadable — will fall through to "API key ausente"
				this.logService.debug('[neocode qwen auth] OAuth credentials are not available.', error);
			}

			if (refreshFailure) {
				throw refreshFailure;
			}
		}

		const maskedEnv: Record<string, string> = {};
		for (const [k, v] of Object.entries(env)) {
			maskedEnv[k] = v.length > 8 ? `${v.slice(0, 4)}...${v.slice(-3)}` : '***';
		}
		return { env, maskedEnv };
	}

	async syncQwenConfig(): Promise<void> {
		const config = this.loadConfig();
		await this.configWriter.syncConfig(config);
	}

	async getDiagnostics(): Promise<IQwenDiagnostics> {
		const config = this.loadConfig();
		const cli = await this.detectQwenCli();
		const hasBrokenAuthState = await this.configWriter.hasBrokenAuthState();
		return buildQwenDiagnostics(config, cli, hasBrokenAuthState);
	}

	exportConfigWithoutSecrets(): IQwenConfigExport {
		return toExportConfig(this.loadConfig());
	}

	async removeGeneratedQwenConfig(): Promise<void> {
		await this.configWriter.removeGeneratedConfig();
	}

	private normalizeConfig(config: IQwenProviderConfig): IQwenProviderConfig {
		const credentials = Array.isArray(config.credentials)
			? config.credentials
				.filter(credential => !!credential?.id && !!credential?.authType)
				.map(credential => ({
					...credential,
					name: credential.name?.trim() || `Credencial ${credential.id.slice(0, 6)}`,
				}))
			: [];
		const activeCredentialId = credentials.some(credential => credential.id === config.activeCredentialId)
			? config.activeCredentialId
			: credentials[0]?.id;
		return {
			...config,
			credentials,
			activeCredentialId,
		};
	}

	private getActiveCredential(config: IQwenProviderConfig): IQwenStoredCredential | undefined {
		const credentials = config.credentials ?? [];
		if (!credentials.length) {
			return undefined;
		}
		if (config.activeCredentialId) {
			const active = credentials.find(credential => credential.id === config.activeCredentialId);
			if (active) {
				return active;
			}
		}
		return credentials[0];
	}

	private resolveTargetCredentialId(
		credentials: IQwenStoredCredential[],
		authType: IQwenStoredCredential['authType'],
		options: { credentialId?: string; createNewCredential?: boolean; activeCredentialId?: string },
	): string {
		if (options.credentialId) {
			return options.credentialId;
		}
		if (!options.createNewCredential && options.activeCredentialId) {
			const active = credentials.find(credential => credential.id === options.activeCredentialId);
			if (active?.authType === authType) {
				return active.id;
			}
		}
		return generateUuid();
	}

	private upsertCredential(credentials: IQwenStoredCredential[], credential: IQwenStoredCredential): void {
		const index = credentials.findIndex(item => item.id === credential.id);
		if (index >= 0) {
			credentials[index] = credential;
			return;
		}
		credentials.push(credential);
	}

	private apiKeySecretForCredential(credentialId: string): string {
		return `${NEO_QWEN_SECRET_API_KEY_PREFIX}${credentialId}`;
	}

	private oauthSecretForCredential(credentialId: string): string {
		return `${NEO_QWEN_SECRET_OAUTH_CREDENTIAL_PREFIX}${credentialId}`;
	}

	private async readOAuthCredentialFromSecret(credentialId: string): Promise<IQwenOAuthCredentials | undefined> {
		try {
			const raw = await this.secretStorageService.get(this.oauthSecretForCredential(credentialId));
			if (!raw?.trim()) {
				return undefined;
			}
			return JSON.parse(raw) as IQwenOAuthCredentials;
		} catch {
			return undefined;
		}
	}

	private async readOAuthCredsFromFile(): Promise<IQwenOAuthCredentials | undefined> {
		try {
			const userHomeUri = await this.pathService.userHome();
			const credUri = URI.joinPath(userHomeUri, '.qwen', 'oauth_creds.json');
			const content = await this.fileService.readFile(credUri);
			const text = content.value.toString();
			if (!text.trim()) {
				return undefined;
			}
			return JSON.parse(text) as IQwenOAuthCredentials;
		} catch {
			return undefined;
		}
	}

	private async saveOAuthCredentialMetadata(
		currentConfig: IQwenProviderConfig,
		credentialsPayload: IQwenOAuthCredentials,
		options?: IQwenOAuthStartOptions,
	): Promise<void> {
		const now = Date.now();
		const next = this.loadConfig();
		const credentials = [...(next.credentials ?? [])];
		const targetCredentialId = this.resolveTargetCredentialId(credentials, 'qwen-oauth', {
			credentialId: options?.credentialId,
			createNewCredential: options?.createNewCredential,
			activeCredentialId: next.activeCredentialId,
		});
		const existing = credentials.find(credential => credential.id === targetCredentialId);
		const credentialName = options?.credentialName?.trim()
			|| existing?.name
			|| `Qwen OAuth ${new Date(now).toLocaleString()}`;
		this.upsertCredential(credentials, {
			id: targetCredentialId,
			name: credentialName,
			authType: 'qwen-oauth',
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
			lastUsedAt: now,
		});
		await this.secretStorageService.set(this.oauthSecretForCredential(targetCredentialId), JSON.stringify(credentialsPayload));
		this.storeConfig({
			...currentConfig,
			...next,
			authType: 'qwen-oauth',
			credentials,
			activeCredentialId: targetCredentialId,
		});
	}

	private storeConfig(config: IQwenProviderConfig): void {
		this.storageService.store(NEO_QWEN_STORAGE_KEY, JSON.stringify(this.normalizeConfig(config)), StorageScope.PROFILE, StorageTarget.USER);
	}
}

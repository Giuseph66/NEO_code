/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
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
	NEO_QWEN_SECRET_API_KEY,
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
			return {
				...fallback,
				...parsed,
				envVarName: parsed.envVarName || protocolDefaultEnvVar(protocol),
			};
		} catch {
			return fallback;
		}
	}

	async saveApiKeyConfig(config: Partial<IQwenProviderConfig> & { apiKey: string }): Promise<void> {
		const current = this.loadConfig();
		const next: IQwenProviderConfig = {
			...current,
			...config,
			authType: 'apiKey',
			envVarName: config.envVarName || protocolDefaultEnvVar(config.protocol ?? current.protocol),
		};
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

	async startNativeOAuthFlow(onProgress?: (msg: string) => void): Promise<IQwenConnectionTestResult> {
		const config = this.loadConfig();
		let controller: QwenOAuthDeviceFlowController | undefined;
		try {
			// First check if we already have valid credentials cached
			if (onProgress) {
				onProgress(localize('neocode.qwen.oauth.checking', 'Verificando credenciais OAuth existentes...'));
			}

			const existing = await this.checkOAuthCredsFile();
			if (existing?.ok) {
				this.storeConfig({ ...config, authType: 'qwen-oauth', lastConnectionStatus: 'connected', lastConnectionMessage: existing.message });
				return existing;
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
				this.storeConfig({
					...config,
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
		await this.secretStorageService.delete(NEO_QWEN_SECRET_API_KEY);
		await this.clearOAuthCredentialFiles();
		this._activeDeviceFlowController?.cancel();
		this._activeDeviceFlowController?.dispose();
		this._activeDeviceFlowController = undefined;
		const current = this.loadConfig();
		this.storeConfig({ ...current, lastConnectionStatus: 'unknown', lastConnectionMessage: 'Credenciais removidas.' });
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
		const apiKey = (await this.secretStorageService.get(NEO_QWEN_SECRET_API_KEY))?.trim();
		const env: Record<string, string> = {};
		if (apiKey && config.authType === 'apiKey') {
			env[config.envVarName] = apiKey;
		}

		// OAuth: load access_token from ~/.qwen/oauth_creds.json
		if (config.authType === 'qwen-oauth' && !env[config.envVarName]) {
			let refreshFailure: Error | undefined;
			try {
				const userHomeUri = await this.pathService.userHome();
				const credUri = URI.joinPath(userHomeUri, '.qwen', 'oauth_creds.json');
				const content = await this.fileService.readFile(credUri);
				let creds = JSON.parse(content.value.toString()) as IQwenOAuthCredentials;

				if (creds.access_token && creds.refresh_token && creds.expiry_date) {
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
									refreshFailure = new Error(message);
								}
							}
						} finally {
							controller.dispose();
						}
					}
				}

				if (creds.resource_url?.trim()) {
					env['QWEN_OAUTH_RESOURCE_URL'] = creds.resource_url.trim();
				}

				if (creds.access_token?.trim() && !refreshFailure) {
					env[config.envVarName] = creds.access_token.trim();
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

	private storeConfig(config: IQwenProviderConfig): void {
		this.storageService.store(NEO_QWEN_STORAGE_KEY, JSON.stringify(config), StorageScope.PROFILE, StorageTarget.USER);
	}
}

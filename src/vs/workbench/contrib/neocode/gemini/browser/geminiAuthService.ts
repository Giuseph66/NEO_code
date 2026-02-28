/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { buildGeminiDiagnostics } from './geminiDiagnostics.js';
import { GeminiGoogleAuthController, isGeminiTokenExpiredOrNearExpiry, IGeminiTokenBundle } from './geminiGoogleAuthController.js';
import { GeminiSdkRuntime } from './geminiSdkRuntime.js';
import { createDefaultGeminiProviderConfig, maskSecret, sanitizeGeminiError, toExportConfig } from '../common/geminiConfigSchema.js';
import {
	IGeminiAuthService,
	IGeminiConfigExport,
	IGeminiConnectionTestResult,
	IGeminiDiagnostics,
	IGeminiProviderConfig,
	IGeminiRuntimeEnvResult,
	NEO_GEMINI_SECRET_API_KEY,
	NEO_GEMINI_SECRET_GOOGLE_API_KEY,
	NEO_GEMINI_SECRET_SERVICE_ACCOUNT,
	NEO_GEMINI_SECRET_OAUTH_TOKENS,
	NEO_GEMINI_STORAGE_KEY
} from '../common/geminiTypes.js';

export class GeminiAuthService extends Disposable implements IGeminiAuthService {
	declare readonly _serviceBrand: undefined;

	private readonly authController: GeminiGoogleAuthController;
	private readonly sdkRuntime: GeminiSdkRuntime;

	constructor(
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@IStorageService private readonly storageService: IStorageService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
		@IFileService private readonly fileService: IFileService,
	) {
		super();
		this.authController = this._register(instantiationService.createInstance(GeminiGoogleAuthController));
		this.sdkRuntime = this._register(instantiationService.createInstance(GeminiSdkRuntime));
	}

	// ─── Config persistence ────────────────────────────────────────────────────

	loadConfig(): IGeminiProviderConfig {
		const fallback = createDefaultGeminiProviderConfig();
		const raw = this.storageService.get(NEO_GEMINI_STORAGE_KEY, StorageScope.PROFILE);
		if (!raw) {
			return fallback;
		}
		try {
			const parsed = JSON.parse(raw) as Partial<IGeminiProviderConfig>;
			return { ...fallback, ...parsed };
		} catch {
			return fallback;
		}
	}

	private storeConfig(config: IGeminiProviderConfig): void {
		this.logService.debug('GeminiAuthService: storing configuration');
		this.storageService.store(NEO_GEMINI_STORAGE_KEY, JSON.stringify(config), StorageScope.PROFILE, StorageTarget.USER);
	}

	// ─── Save methods ──────────────────────────────────────────────────────────

	async saveApiKeyConfig(config: Partial<IGeminiProviderConfig> & { apiKey: string }): Promise<void> {
		const current = this.loadConfig();
		const next: IGeminiProviderConfig = {
			...current,
			...config,
			authType: 'apiKey',
		};
		// Store secret based on which env var the user wants to inject
		const secretKey = config.apiKeyVar === 'GOOGLE_API_KEY'
			? NEO_GEMINI_SECRET_GOOGLE_API_KEY
			: NEO_GEMINI_SECRET_API_KEY;
		await this.secretStorageService.set(secretKey, config.apiKey.trim());
		this.storeConfig(next);
	}

	async saveGoogleLoginPreference(config: Partial<IGeminiProviderConfig>): Promise<void> {
		const current = this.loadConfig();
		const next: IGeminiProviderConfig = {
			...current,
			...config,
			authType: 'googleLogin',
		};
		this.storeConfig(next);
	}

	// ─── Native Google Login ────────────────────────────────────────────────────

	async startNativeGoogleLoginFlow(): Promise<IGeminiConnectionTestResult> {
		const config = this.loadConfig();
		try {
			const tokens = await this.authController.signInWithGoogle();
			await this.secretStorageService.set(NEO_GEMINI_SECRET_OAUTH_TOKENS, JSON.stringify(tokens));

			this.storeConfig({
				...config,
				authType: 'googleLogin',
				lastConnectionStatus: 'connected',
				lastConnectionMessage: localize('neocode.gemini.login.success', 'Login concluido e tokens armazenados com sucesso.')
			});
			return {
				ok: true,
				kind: 'connected',
				message: localize('neocode.gemini.login.success', 'Login concluido e tokens armazenados com sucesso.')
			};
		} catch (error) {
			const message = sanitizeGeminiError(error instanceof Error ? error.message : String(error));
			this.storeConfig({
				...config,
				authType: 'googleLogin',
				lastConnectionStatus: 'error',
				lastConnectionMessage: message
			});
			return {
				ok: false,
				kind: 'unknown_error',
				message
			};
		}
	}

	// ─── Connection tests ──────────────────────────────────────────────────────

	async refreshOAuthTokenIfNecessary(): Promise<void> {
		const config = this.loadConfig();
		if (config.authType !== 'googleLogin') {
			return;
		}

		const tokensRaw = await this.secretStorageService.get(NEO_GEMINI_SECRET_OAUTH_TOKENS);
		if (!tokensRaw) {
			return;
		}

		try {
			const tokens = JSON.parse(tokensRaw) as IGeminiTokenBundle;
			if (isGeminiTokenExpiredOrNearExpiry(tokens)) {
				this.logService.info('GeminiAuthService: Token is expired or near expiry, refreshing...');
				// Actually GeminiGoogleAuthController has refreshGeminiTokenBundle exported
				const { refreshGeminiTokenBundle } = await import('./geminiGoogleAuthController.js');
				const credentials = await this.authController.getCredentials();
				const refreshed = await refreshGeminiTokenBundle(tokens, credentials);
				await this.secretStorageService.set(NEO_GEMINI_SECRET_OAUTH_TOKENS, JSON.stringify(refreshed));
				this.logService.info('GeminiAuthService: Token refreshed successfully');
			}
		} catch (error) {
			this.logService.error('GeminiAuthService: Failed to refresh token', error);
		}
	}

	async testApiKeyConnection(): Promise<IGeminiConnectionTestResult> {
		const config = this.loadConfig();
		const secretKey = config.apiKeyVar === 'GOOGLE_API_KEY'
			? NEO_GEMINI_SECRET_GOOGLE_API_KEY
			: NEO_GEMINI_SECRET_API_KEY;
		const apiKey = (await this.secretStorageService.get(secretKey))?.trim();
		if (!apiKey) {
			const result: IGeminiConnectionTestResult = {
				ok: false,
				kind: 'missing_key',
				message: localize('neocode.gemini.apiKey.missing', 'Nenhuma API key encontrada. Configure na aba API Key.')
			};
			this.storeConfig({ ...config, lastConnectionStatus: 'error', lastConnectionMessage: result.message, lastConnectionAt: Date.now() });
			return result;
		}
		try {
			const result = await this.sdkRuntime.testApiKeyConnection(apiKey, config.modelName);
			this.storeConfig({ ...config, lastConnectionStatus: result.ok ? 'connected' : 'error', lastConnectionMessage: result.message, lastConnectionAt: Date.now() });
			return result;
		} catch (error) {
			const message = sanitizeGeminiError(error instanceof Error ? error.message : String(error));
			this.storeConfig({ ...config, lastConnectionStatus: 'error', lastConnectionMessage: message, lastConnectionAt: Date.now() });
			return { ok: false, kind: 'unknown_error', message };
		}
	}



	async testGoogleLoginConnection(): Promise<IGeminiConnectionTestResult> {
		await this.refreshOAuthTokenIfNecessary();
		const config = this.loadConfig();
		const tokensRaw = await this.secretStorageService.get(NEO_GEMINI_SECRET_OAUTH_TOKENS);
		if (!tokensRaw?.trim()) {
			const result: IGeminiConnectionTestResult = {
				ok: false,
				kind: 'auth_required',
				message: localize('neocode.gemini.oauth.missing', 'Nenhuma sessao Google encontrada. Faca o login novamente.')
			};
			this.storeConfig({ ...config, lastConnectionStatus: 'error', lastConnectionMessage: result.message, lastConnectionAt: Date.now() });
			return result;
		}

		try {
			const parsed = JSON.parse(tokensRaw) as { accessToken?: string };
			if (!parsed.accessToken) {
				throw new Error('Token ausente.');
			}
			const result = await this.sdkRuntime.testGoogleLoginConnection(parsed.accessToken);
			this.storeConfig({ ...config, lastConnectionStatus: result.ok ? 'connected' : 'error', lastConnectionMessage: result.message, lastConnectionAt: Date.now() });
			return result;
		} catch (error) {
			const message = sanitizeGeminiError(error instanceof Error ? error.message : String(error));
			this.storeConfig({ ...config, lastConnectionStatus: 'error', lastConnectionMessage: message, lastConnectionAt: Date.now() });
			return { ok: false, kind: 'unknown_error', message };
		}
	}

	// ─── Runtime env assembly ──────────────────────────────────────────────────

	async buildRuntimeEnv(): Promise<IGeminiRuntimeEnvResult> {
		await this.refreshOAuthTokenIfNecessary();
		const config = this.loadConfig();
		const env: Record<string, string> = {};

		if (config.authType === 'apiKey') {
			const secretKey = config.apiKeyVar === 'GOOGLE_API_KEY'
				? NEO_GEMINI_SECRET_GOOGLE_API_KEY
				: NEO_GEMINI_SECRET_API_KEY;
			const apiKey = (await this.secretStorageService.get(secretKey))?.trim();
			if (apiKey) {
				env[config.apiKeyVar] = apiKey;
			}
		} else if (config.authType === 'googleLogin') {
			if (config.googleCloudProject) {
				env['GOOGLE_CLOUD_PROJECT'] = config.googleCloudProject;
			}
		}

		// Build masked copy for safe display / logging
		const maskedEnv: Record<string, string> = {};
		for (const [k, v] of Object.entries(env)) {
			maskedEnv[k] = maskSecret(v) || '***';
		}

		return { env, maskedEnv };
	}

	// ─── Credentials management ────────────────────────────────────────────────

	async clearAllGeminiCredentials(): Promise<void> {
		await this.secretStorageService.delete(NEO_GEMINI_SECRET_API_KEY);
		await this.secretStorageService.delete(NEO_GEMINI_SECRET_GOOGLE_API_KEY);
		await this.secretStorageService.delete(NEO_GEMINI_SECRET_SERVICE_ACCOUNT);
		await this.secretStorageService.delete(NEO_GEMINI_SECRET_OAUTH_TOKENS);

		const current = this.loadConfig();
		this.storeConfig({
			...current,
			lastConnectionStatus: 'unknown',
			lastConnectionMessage: localize('neocode.gemini.credentials.cleared', 'Credenciais Gemini removidas.')
		});
	}

	// ─── Diagnostics ───────────────────────────────────────────────────────────

	async getDiagnostics(): Promise<IGeminiDiagnostics> {
		const config = this.loadConfig();
		const hasGeminiApiKey = !!((await this.secretStorageService.get(NEO_GEMINI_SECRET_API_KEY))?.trim());
		const hasGoogleApiKey = !!((await this.secretStorageService.get(NEO_GEMINI_SECRET_GOOGLE_API_KEY))?.trim());
		const hasServiceAccount = !!((await this.secretStorageService.get(NEO_GEMINI_SECRET_SERVICE_ACCOUNT))?.trim());
		const tokensRaw = await this.secretStorageService.get(NEO_GEMINI_SECRET_OAUTH_TOKENS);
		const hasOAuthTokens = !!tokensRaw;

		let email: string | undefined;
		if (tokensRaw) {
			try {
				const parsed = JSON.parse(tokensRaw) as { accessToken?: string };
				if (parsed.accessToken) {
					const info = await this.sdkRuntime.testGoogleLoginConnection(parsed.accessToken);
					if (info.ok) {
						// Extract email from "Conexao com conta Google bem-sucedida (email)."
						const match = info.message.match(/\(([^)]+)\)/);
						if (match) { email = match[1]; }
					}
				}
			} catch { }
		}

		// Read security.auth.selectedType from settings.json for diagnostic display
		let securityAuthSelectedType: string | undefined;
		try {
			const homeDir = typeof process !== 'undefined' ? (process.env['HOME'] || process.env['USERPROFILE'] || '') : '';
			if (homeDir) {
				const settingsUri = URI.file(`${homeDir}/.gemini/settings.json`);
				const content = await this.fileService.readFile(settingsUri);
				const parsed = JSON.parse(content.value.toString()) as any;
				securityAuthSelectedType = parsed?.security?.auth?.selectedType;
			}
		} catch {
			// File not found or not parseable — leave undefined
		}

		const diag = buildGeminiDiagnostics(config, { hasGeminiApiKey, hasGoogleApiKey, hasServiceAccount, hasOAuthTokens });
		diag.securityAuthSelectedType = securityAuthSelectedType;
		diag.email = email;
		return diag;
	}

	// ─── Export ────────────────────────────────────────────────────────────────

	exportConfigWithoutSecrets(): IGeminiConfigExport {
		return toExportConfig(this.loadConfig());
	}
}

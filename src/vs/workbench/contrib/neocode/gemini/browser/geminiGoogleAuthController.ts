/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IChannel, ProxyChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IOpenAILoopbackCallbackServerService, IOpenAILoopbackResult, NEO_SWARM_OPENAI_LOOPBACK_CHANNEL } from '../../../neocodeSwarm/common/neocodeSwarmOpenAILoopbackTypes.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { parseEnvFile } from '../../../../../base/common/envfile.js';

let GOOGLE_OAUTH_CLIENT_ID_CACHED: string | undefined;
let GOOGLE_OAUTH_CLIENT_SECRET_CACHED: string | undefined;
const GOOGLE_OAUTH_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_OAUTH_REDIRECT_URI = 'http://127.0.0.1:1456/oauth2callback';
const GOOGLE_OAUTH_SCOPE = 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile';
const GOOGLE_OAUTH_CALLBACK_TIMEOUT_MS = 15 * 60 * 1000;
const LOOPBACK_WORKER_MODULE_ID = 'vs/workbench/contrib/neocodeSwarm/node/neocodeSwarmOpenAILoopbackMain';

interface ILoopbackWorkerHandle {
	waitForResult(): Promise<IOpenAILoopbackResult>;
	stop(): Promise<void>;
}

interface IUtilityProcessWorkerHandle {
	client: { getChannel(channelName: string): IChannel };
	dispose(): void;
}

interface IUtilityProcessWorkerServiceLike {
	createWorker(process: { moduleId: string; type: string; name: string }): Promise<IUtilityProcessWorkerHandle>;
}

export interface IGeminiTokenBundle {
	accessToken: string;
	refreshToken?: string;
	tokenType?: string;
	scope?: string;
	expiresAt?: number;
}

export function parseStoredGeminiTokenBundle(rawValue: string): IGeminiTokenBundle | undefined {
	const trimmed = rawValue.trim();
	if (!trimmed) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(trimmed) as Partial<IGeminiTokenBundle>;
		if (!parsed.accessToken?.trim()) {
			return undefined;
		}
		return {
			accessToken: parsed.accessToken.trim(),
			refreshToken: parsed.refreshToken?.trim(),
			tokenType: parsed.tokenType?.trim(),
			scope: parsed.scope?.trim(),
			expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : undefined
		};
	} catch {
		// Legacy fallback if someone manages to type a plain token
		return { accessToken: trimmed };
	}
}

export function isGeminiTokenExpiredOrNearExpiry(token: IGeminiTokenBundle): boolean {
	if (!token.expiresAt) {
		return false; // No expiry info, assume it's still good for now
	}
	// Buffer of 5 minutes to prevent corner cases during long operations
	const bufferMs = 5 * 60 * 1000;
	return Date.now() + bufferMs > token.expiresAt;
}

export async function refreshGeminiTokenBundle(token: IGeminiTokenBundle, credentials: { clientId: string; clientSecret: string }): Promise<IGeminiTokenBundle> {
	const refreshToken = token.refreshToken?.trim();
	if (!refreshToken) {
		throw new Error(localize('neocode.gemini.refresh.missingRefreshToken', 'Token nao possui refresh_token. Faca o login novamente.'));
	}

	const body = new URLSearchParams();
	body.set('client_id', credentials.clientId);
	body.set('client_secret', credentials.clientSecret);
	body.set('grant_type', 'refresh_token');
	body.set('refresh_token', refreshToken);

	const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			'Accept': 'application/json'
		},
		body: body.toString()
	});

	if (!response.ok) {
		let detail = '';
		try {
			const payload = await response.json() as { error?: string; error_description?: string };
			detail = payload.error_description || payload.error || '';
		} catch {
			// ignore parse errors
		}
		throw new Error(detail
			? localize('neocode.gemini.refresh.failedDetailed', 'Falha ao atualizar token Google OAuth (HTTP {0}): {1}', response.status, detail)
			: localize('neocode.gemini.refresh.failed', 'Falha ao atualizar token Google OAuth (HTTP {0}).', response.status));
	}

	const payload = await response.json() as {
		access_token?: string;
		refresh_token?: string;
		token_type?: string;
		scope?: string;
		expires_in?: number;
	};
	if (!payload.access_token) {
		throw new Error(localize('neocode.gemini.refresh.invalidPayload', 'Resposta de refresh de token invalida.'));
	}

	return {
		accessToken: payload.access_token,
		refreshToken: payload.refresh_token ?? token.refreshToken,
		tokenType: payload.token_type ?? token.tokenType,
		scope: payload.scope ?? token.scope,
		expiresAt: payload.expires_in ? Date.now() + (payload.expires_in * 1000) : token.expiresAt
	};
}

export class GeminiGoogleAuthController extends Disposable {
	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IDialogService private readonly dialogService: IDialogService,
		@IFileService private readonly fileService: IFileService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService
	) {
		super();
	}

	public async getCredentials(): Promise<{ clientId: string; clientSecret: string }> {
		if (GOOGLE_OAUTH_CLIENT_ID_CACHED && GOOGLE_OAUTH_CLIENT_SECRET_CACHED) {
			return { clientId: GOOGLE_OAUTH_CLIENT_ID_CACHED, clientSecret: GOOGLE_OAUTH_CLIENT_SECRET_CACHED };
		}

		// Try to load from .env in the app root
		try {
			// For NeoCode/VS Code, the .env is usually in the workspace or app root.
			const potentialPaths = [
				URI.joinPath(this.environmentService.userRoamingDataHome, '../../.env'), // Dev path
				URI.file('/home/jesus/NEO_code/.env') // Absolute path for this specific environment
			];

			for (const uri of potentialPaths) {
				try {
					const content = await this.fileService.readFile(uri);
					const env = parseEnvFile(content.value.toString());
					const cid = env.get('GOOGLE_CLIENT_ID');
					const csec = env.get('GOOGLE_CLIENT_SECRET');
					if (cid && csec) {
						GOOGLE_OAUTH_CLIENT_ID_CACHED = cid;
						GOOGLE_OAUTH_CLIENT_SECRET_CACHED = csec;
						return { clientId: cid, clientSecret: csec };
					}
				} catch {
					// continue
				}
			}
		} catch {
			// ignore
		}

		throw new Error(localize('neocode.gemini.oauth.credentialsMissing', 'Credenciais Google OAuth (Client ID/Secret) nao encontradas no arquivo .env.'));
	}

	async signInWithGoogle(): Promise<IGeminiTokenBundle> {
		const credentials = await this.getCredentials();
		const state = this.generateRandomString(32);
		const loopbackWorker = await this.startLoopbackCallbackWorker(state);

		const authorizeUrl = new URL(GOOGLE_OAUTH_AUTHORIZE_URL);
		authorizeUrl.searchParams.set('client_id', credentials.clientId);
		authorizeUrl.searchParams.set('response_type', 'code');
		authorizeUrl.searchParams.set('scope', GOOGLE_OAUTH_SCOPE);
		authorizeUrl.searchParams.set('redirect_uri', GOOGLE_OAUTH_REDIRECT_URI);
		authorizeUrl.searchParams.set('access_type', 'offline');
		authorizeUrl.searchParams.set('state', state);

		let callbackResult: URI | undefined;
		try {
			const opened = await this.openerService.open(URI.parse(authorizeUrl.toString()), {
				openExternal: true,
				allowContributedOpeners: false
			});
			if (!opened) {
				throw new Error(localize('neocode.gemini.oauth.openFailed', 'Nao foi possivel abrir o navegador para login no Google.'));
			}

			let loopbackResult: IOpenAILoopbackResult | undefined;
			try {
				loopbackResult = await loopbackWorker.waitForResult();
			} catch (error) {
				callbackResult = await this.promptManualCallback(
					state,
					localize('neocode.gemini.oauth.manual.loopbackCrashed', 'Servidor de callback local encerrou com erro: {0}. Conclua o login e cole a URL manualmente.', error instanceof Error ? error.message : String(error)),
					GOOGLE_OAUTH_REDIRECT_URI
				);
			}
			if (loopbackResult?.kind === 'timeout') {
				callbackResult = await this.promptManualCallback(
					state,
					localize('neocode.gemini.oauth.manual.timeout', 'Nao recebemos o callback local em ate 15 minutos. Conclua o login no navegador e cole a URL final (localhost) ou somente o codigo retornado.'),
					GOOGLE_OAUTH_REDIRECT_URI
				);
			} else if (loopbackResult?.query?.trim()) {
				callbackResult = this.createCallbackUriFromQuery(loopbackResult.query);
			} else if (!callbackResult) {
				callbackResult = await this.promptManualCallback(
					state,
					loopbackResult?.error
						? localize('neocode.gemini.oauth.manual.loopbackError', 'Servidor de callback local retornou erro: {0}. Conclua o login e cole a URL manualmente.', loopbackResult.error)
						: localize('neocode.gemini.oauth.manual.loopbackUnknown', 'Nao foi possivel capturar o callback local automaticamente. Conclua o login e cole a URL manualmente.'),
					GOOGLE_OAUTH_REDIRECT_URI
				);
			}
		} finally {
			await loopbackWorker.stop();
		}
		if (!callbackResult) {
			throw new Error(localize('neocode.gemini.oauth.callbackUnavailable', 'Nao foi possivel receber o callback do login do Google.'));
		}

		const params = new URLSearchParams(callbackResult.query);
		const error = params.get('error');
		if (error) {
			const errorDescription = params.get('error_description');
			throw new Error(errorDescription
				? localize('neocode.gemini.oauth.errorResponseDetailed', 'Login Google recusado: {0} ({1})', error, errorDescription)
				: localize('neocode.gemini.oauth.errorResponse', 'Login Google recusado: {0}', error));
		}
		const receivedCode = params.get('code');
		if (!receivedCode?.trim()) {
			throw new Error(localize('neocode.gemini.oauth.missingCode', 'Nenhum codigo de autorizacao foi recebido.'));
		}

		const receivedState = params.get('state');
		if (!receivedState || !this.stateMatchesNonce(receivedState, state)) {
			throw new Error(localize('neocode.gemini.oauth.invalidState', 'Falha de validacao de estado do login (state mismatch).'));
		}

		return this.exchangeCodeForToken(receivedCode, GOOGLE_OAUTH_REDIRECT_URI, credentials);
	}

	private async startLoopbackCallbackWorker(expectedState: string): Promise<ILoopbackWorkerHandle> {
		let utilityProcessService: IUtilityProcessWorkerServiceLike;
		try {
			// Dynamically import the utility process service
			const module = await import('../../../../services/utilityProcess/electron-browser/utilityProcessWorkerWorkbenchService.js');
			utilityProcessService = this.instantiationService.invokeFunction(accessor => accessor.get(module.IUtilityProcessWorkerWorkbenchService)) as IUtilityProcessWorkerServiceLike;
		} catch (error) {
			throw new Error(localize('neocode.gemini.oauth.loopback.workerUnavailable', 'Nao foi possivel iniciar o servidor de callback local em processo separado. {0}', error instanceof Error ? error.message : String(error)));
		}

		let worker: IUtilityProcessWorkerHandle;
		try {
			worker = await utilityProcessService.createWorker({
				moduleId: LOOPBACK_WORKER_MODULE_ID,
				type: 'oauthLoopback',
				name: 'NeoCode Google OAuth Callback'
			});
		} catch (error) {
			throw new Error(localize('neocode.gemini.oauth.loopback.createWorkerFailed', 'Nao foi possivel iniciar o processo de callback local. {0}', error instanceof Error ? error.message : String(error)));
		}

		// Re-use the Swarm OpenAI loopback channel since it's generic enough (receives code & state on root path)
		const loopbackService = ProxyChannel.toService<IOpenAILoopbackCallbackServerService>(worker.client.getChannel(NEO_SWARM_OPENAI_LOOPBACK_CHANNEL));
		const redirect = new URL(GOOGLE_OAUTH_REDIRECT_URI);
		const port = Number(redirect.port || '80');
		const path = redirect.pathname || '/';

		try {
			await loopbackService.start({
				host: redirect.hostname,
				port,
				path,
				expectedState,
				timeoutMs: GOOGLE_OAUTH_CALLBACK_TIMEOUT_MS
			});
		} catch (error) {
			worker.dispose();
			throw new Error(localize('neocode.gemini.oauth.loopback.startFailed', 'Nao foi possivel iniciar callback local em {0}. Erro: {1}', GOOGLE_OAUTH_REDIRECT_URI, error instanceof Error ? error.message : String(error)));
		}

		let stopped = false;
		return {
			waitForResult: () => loopbackService.waitForResult(),
			stop: async () => {
				if (stopped) {
					return;
				}
				stopped = true;
				try {
					await loopbackService.stop();
				} catch {
					// ignore shutdown errors to always dispose the worker
				} finally {
					worker.dispose();
				}
			}
		};
	}

	private createCallbackUriFromQuery(query: string): URI {
		const redirect = new URL(GOOGLE_OAUTH_REDIRECT_URI);
		return URI.from({
			scheme: redirect.protocol.replace(':', ''),
			authority: redirect.host,
			path: redirect.pathname || '/',
			query
		});
	}

	private stateMatchesNonce(receivedState: string, nonce: string): boolean {
		if (!receivedState.trim()) {
			return false;
		}
		if (receivedState.trim() === nonce) {
			return true;
		}
		if (receivedState.includes(`nonce=${encodeURIComponent(nonce)}`) || receivedState.includes(`nonce=${nonce}`)) {
			return true;
		}
		const parsed = tryParseUri(receivedState);
		if (!parsed) {
			return false;
		}
		return new URLSearchParams(parsed.query).get('nonce') === nonce || new URLSearchParams(parsed.query).get('state') === nonce;
	}

	private async promptManualCallback(expectedNonce: string, reason?: string, redirectUri?: string): Promise<URI> {
		const displayRedirect = redirectUri ?? GOOGLE_OAUTH_REDIRECT_URI;
		const pickManual = await this.dialogService.confirm({
			type: 'info',
			message: localize('neocode.gemini.oauth.manual.title', 'Continue o login no navegador e volte para concluir.'),
			detail: reason
				? localize('neocode.gemini.oauth.manual.detailReason', '{0}', reason)
				: localize('neocode.gemini.oauth.manual.detail', 'Cole a URL final (ou apenas o codigo) para finalizar a autenticacao.'),
			primaryButton: localize('neocode.gemini.oauth.manual.primary', 'Colar URL/Codigo')
		});
		if (!pickManual.confirmed) {
			throw new Error(localize('neocode.gemini.oauth.cancelled', 'Login Google cancelado.'));
		}

		const value = await this.quickInputService.input({
			prompt: localize('neocode.gemini.oauth.manual.prompt', 'Cole a URL completa (ou somente o parametro code)'),
			placeHolder: `${displayRedirect}?code=...&state=...`,
			validateInput: async input => {
				const trimmed = input.trim();
				if (!trimmed) {
					return localize('neocode.gemini.oauth.manual.required', 'Informe a URL de retorno ou o codigo.');
				}
				if (!trimmed.includes('://')) {
					return undefined; // Assume it's just the code
				}
				const parsed = tryParseUri(trimmed);
				if (!parsed) {
					return localize('neocode.gemini.oauth.manual.invalidUrl', 'URL invalida.');
				}
				const params = new URLSearchParams(parsed.query);
				if (!params.get('code')) {
					return localize('neocode.gemini.oauth.manual.codeMissing', 'A URL precisa conter o parametro code.');
				}
				const state = params.get('state');
				if (state && !this.stateMatchesNonce(state, expectedNonce)) {
					return localize('neocode.gemini.oauth.manual.stateInvalid', 'State invalido. Reinicie o login.');
				}
				return undefined;
			}
		});
		if (!value?.trim()) {
			throw new Error(localize('neocode.gemini.oauth.cancelled', 'Login Google cancelado.'));
		}
		const trimmed = value.trim();
		if (!trimmed.includes('://')) {
			return URI.from({
				scheme: 'neocode',
				authority: 'manual',
				path: '/oauth',
				query: `code=${encodeURIComponent(trimmed)}&state=${encodeURIComponent(expectedNonce)}`
			});
		}
		const parsed = tryParseUri(trimmed);
		if (!parsed) {
			throw new Error(localize('neocode.gemini.oauth.manual.invalidUrl', 'URL invalida.'));
		}
		return parsed;
	}

	private async exchangeCodeForToken(code: string, redirectUri: string, credentials: { clientId: string; clientSecret: string }): Promise<IGeminiTokenBundle> {
		const payload = await exchangeGoogleCodeForToken(code, redirectUri, credentials);
		if (!payload.access_token) {
			throw new Error(localize('neocode.gemini.oauth.invalidTokenPayload', 'Resposta de token invalida do Google.'));
		}

		return {
			accessToken: payload.access_token,
			refreshToken: payload.refresh_token,
			tokenType: payload.token_type,
			scope: payload.scope,
			expiresAt: payload.expires_in ? Date.now() + (payload.expires_in * 1000) : undefined,
		};
	}

	private generateRandomString(length: number): string {
		const bytes = new Uint8Array(length);
		crypto.getRandomValues(bytes);
		return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('').slice(0, length);
	}
}

interface IGoogleTokenResponse {
	access_token?: string;
	refresh_token?: string;
	token_type?: string;
	scope?: string;
	expires_in?: number;
}

async function exchangeGoogleCodeForToken(code: string, redirectUri: string, credentials: { clientId: string; clientSecret: string }): Promise<IGoogleTokenResponse> {
	const body = new URLSearchParams();
	body.set('client_id', credentials.clientId);
	body.set('client_secret', credentials.clientSecret);
	body.set('grant_type', 'authorization_code');
	body.set('code', code);
	body.set('redirect_uri', redirectUri);

	const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			'Accept': 'application/json'
		},
		body: body.toString()
	});

	if (!response.ok) {
		let detail = '';
		try {
			const payload = await response.json() as { error?: string; error_description?: string };
			detail = payload.error_description || payload.error || '';
		} catch {
			// ignore parse errors
		}
		throw new Error(detail
			? localize('neocode.gemini.oauth.tokenExchangeFailedDetailed', 'Falha ao trocar codigo por token Google (HTTP {0}): {1}', response.status, detail)
			: localize('neocode.gemini.oauth.tokenExchangeFailed', 'Falha ao trocar codigo por token Google (HTTP {0}).', response.status));
	}

	return response.json() as Promise<IGoogleTokenResponse>;
}

function tryParseUri(value: string): URI | undefined {
	try {
		return URI.parse(value);
	} catch {
		return undefined;
	}
}

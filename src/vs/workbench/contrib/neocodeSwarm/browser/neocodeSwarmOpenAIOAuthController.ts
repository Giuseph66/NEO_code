/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IChannel, ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IOpenAILoopbackCallbackServerService, IOpenAILoopbackResult, NEO_SWARM_OPENAI_LOOPBACK_CHANNEL } from '../common/neocodeSwarmOpenAILoopbackTypes.js';

const OPENAI_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_OAUTH_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const OPENAI_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const OPENAI_OAUTH_REDIRECT_URI = 'http://localhost:1455/auth/callback';
const OPENAI_OAUTH_AUDIENCE = 'https://api.openai.com/v1';
const OPENAI_OAUTH_SCOPE = 'openid profile email offline_access';
const REQUIRED_OPENAI_SCOPES = ['openid', 'offline_access'];
const OPENAI_OAUTH_CALLBACK_TIMEOUT_MS = 15 * 60 * 1000;
const OPENAI_OAUTH_LOOPBACK_WORKER_MODULE_ID = 'vs/workbench/contrib/neocodeSwarm/node/neocodeSwarmOpenAILoopbackMain';
export const OPENAI_OAUTH_TOKEN_REFRESH_SKEW_MS = 2 * 60 * 1000;

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

export interface IOpenAITokenBundle {
	accessToken: string;
	refreshToken?: string;
	tokenType?: string;
	scope?: string;
	expiresAt?: number;
	missingScopes?: string[];
}

export function parseStoredOpenAITokenBundle(rawValue: string): IOpenAITokenBundle | undefined {
	const trimmed = rawValue.trim();
	if (!trimmed) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(trimmed) as Partial<IOpenAITokenBundle>;
		if (!parsed.accessToken?.trim()) {
			return undefined;
		}
		return {
			accessToken: parsed.accessToken.trim(),
			refreshToken: parsed.refreshToken?.trim(),
			tokenType: parsed.tokenType?.trim(),
			scope: parsed.scope?.trim(),
			expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : undefined,
			missingScopes: Array.isArray(parsed.missingScopes) ? parsed.missingScopes.filter(Boolean) : undefined
		};
	} catch {
		// Backward-compatibility with legacy plain token storage.
		return { accessToken: trimmed };
	}
}

export function isOpenAITokenExpiredOrNearExpiry(token: IOpenAITokenBundle, skewMs: number = OPENAI_OAUTH_TOKEN_REFRESH_SKEW_MS): boolean {
	if (!token.expiresAt) {
		return false;
	}
	return Date.now() + Math.max(0, skewMs) >= token.expiresAt;
}

export async function refreshOpenAITokenBundle(token: IOpenAITokenBundle): Promise<IOpenAITokenBundle> {
	const refreshToken = token.refreshToken?.trim();
	if (!refreshToken) {
		throw new Error(localize('neoSwarm.oauth.refresh.missingRefreshToken', 'Token nao possui refresh_token.'));
	}

	const body = new URLSearchParams();
	body.set('client_id', OPENAI_OAUTH_CLIENT_ID);
	body.set('grant_type', 'refresh_token');
	body.set('refresh_token', refreshToken);

	const response = await fetch(OPENAI_OAUTH_TOKEN_URL, {
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
			? localize('neoSwarm.oauth.refresh.failedDetailed', 'Falha ao atualizar token OAuth (HTTP {0}): {1}', response.status, detail)
			: localize('neoSwarm.oauth.refresh.failed', 'Falha ao atualizar token OAuth (HTTP {0}).', response.status));
	}

	const payload = await response.json() as {
		access_token?: string;
		refresh_token?: string;
		token_type?: string;
		scope?: string;
		expires_in?: number;
	};
	if (!payload.access_token) {
		throw new Error(localize('neoSwarm.oauth.refresh.invalidPayload', 'Resposta de refresh de token invalida.'));
	}

	const scope = payload.scope ?? token.scope;
	return {
		accessToken: payload.access_token,
		refreshToken: payload.refresh_token ?? token.refreshToken,
		tokenType: payload.token_type ?? token.tokenType,
		scope,
		expiresAt: payload.expires_in ? Date.now() + (payload.expires_in * 1000) : token.expiresAt,
		missingScopes: getMissingOpenAIScopes(scope)
	};
}

export class NeocodeSwarmOpenAIOAuthController extends Disposable {
	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IDialogService private readonly dialogService: IDialogService
	) {
		super();
	}

	async signInWithChatGPT(): Promise<IOpenAITokenBundle> {
		const codeVerifier = this.generateRandomString(64);
		const codeChallenge = await this.generateCodeChallenge(codeVerifier);
		const state = this.generateRandomString(32);
		const loopbackWorker = await this.startLoopbackCallbackWorker(state);
		const authorizeUrl = new URL(OPENAI_OAUTH_AUTHORIZE_URL);
		authorizeUrl.searchParams.set('client_id', OPENAI_OAUTH_CLIENT_ID);
		authorizeUrl.searchParams.set('response_type', 'code');
		authorizeUrl.searchParams.set('scope', OPENAI_OAUTH_SCOPE);
		authorizeUrl.searchParams.set('code_challenge_method', 'S256');
		authorizeUrl.searchParams.set('code_challenge', codeChallenge);
		authorizeUrl.searchParams.set('audience', OPENAI_OAUTH_AUDIENCE);
		authorizeUrl.searchParams.set('codex_cli_simplified_flow', 'true');
		authorizeUrl.searchParams.set('originator', 'codex_cli_rs');
		authorizeUrl.searchParams.set('redirect_uri', OPENAI_OAUTH_REDIRECT_URI);
		authorizeUrl.searchParams.set('state', state);

		let callbackResult: URI | undefined;
		try {
			const opened = await this.openerService.open(URI.parse(authorizeUrl.toString()), {
				openExternal: true,
				allowContributedOpeners: false
			});
			if (!opened) {
				throw new Error(localize('neoSwarm.oauth.openFailed', 'Nao foi possivel abrir o navegador para login.'));
			}

			let loopbackResult: IOpenAILoopbackResult | undefined;
			try {
				loopbackResult = await loopbackWorker.waitForResult();
			} catch (error) {
				callbackResult = await this.promptManualCallback(
					state,
					localize('neoSwarm.oauth.manual.loopbackCrashed', 'Servidor de callback local encerrou com erro: {0}. Conclua o login e cole a URL/codigo manualmente.', error instanceof Error ? error.message : String(error)),
					OPENAI_OAUTH_REDIRECT_URI
				);
			}
			if (loopbackResult?.kind === 'timeout') {
				callbackResult = await this.promptManualCallback(
					state,
					localize('neoSwarm.oauth.manual.timeout', 'Nao recebemos o callback local em ate 15 minutos. Conclua o login no navegador e cole a URL final (localhost) ou somente o codigo retornado.'),
					OPENAI_OAUTH_REDIRECT_URI
				);
			} else if (loopbackResult?.query?.trim()) {
				callbackResult = this.createCallbackUriFromQuery(loopbackResult.query);
			} else if (!callbackResult) {
				callbackResult = await this.promptManualCallback(
					state,
					loopbackResult?.error
						? localize('neoSwarm.oauth.manual.loopbackError', 'Servidor de callback local retornou erro: {0}. Conclua o login e cole a URL/codigo manualmente.', loopbackResult.error)
						: localize('neoSwarm.oauth.manual.loopbackUnknown', 'Nao foi possivel capturar o callback local automaticamente. Conclua o login e cole a URL/codigo manualmente.'),
					OPENAI_OAUTH_REDIRECT_URI
				);
			}
		} finally {
			await loopbackWorker.stop();
		}
		if (!callbackResult) {
			throw new Error(localize('neoSwarm.oauth.callbackUnavailable', 'Nao foi possivel receber o callback do login.'));
		}

		const params = new URLSearchParams(callbackResult.query);
		const error = params.get('error');
		if (error) {
			const errorDescription = params.get('error_description');
			throw new Error(errorDescription
				? localize('neoSwarm.oauth.errorResponseDetailed', 'Login recusado: {0} ({1})', error, errorDescription)
				: localize('neoSwarm.oauth.errorResponse', 'Login recusado: {0}', error));
		}
		const receivedCode = params.get('code');
		if (!receivedCode?.trim()) {
			throw new Error(localize('neoSwarm.oauth.missingCode', 'Nenhum codigo de autorizacao foi recebido.'));
		}

		const receivedState = params.get('state');
		if (!receivedState || !this.stateMatchesNonce(receivedState, state)) {
			throw new Error(localize('neoSwarm.oauth.invalidState', 'Falha de validacao de estado do login.'));
		}

		return this.exchangeCodeForToken(receivedCode, codeVerifier, OPENAI_OAUTH_REDIRECT_URI);
	}

	private async startLoopbackCallbackWorker(expectedState: string): Promise<ILoopbackWorkerHandle> {
		let utilityProcessService: IUtilityProcessWorkerServiceLike;
		try {
			const module = await import('../../../services/utilityProcess/electron-browser/utilityProcessWorkerWorkbenchService.js');
			utilityProcessService = this.instantiationService.invokeFunction(accessor => accessor.get(module.IUtilityProcessWorkerWorkbenchService)) as IUtilityProcessWorkerServiceLike;
		} catch (error) {
			throw new Error(localize('neoSwarm.oauth.loopback.workerUnavailable', 'Nao foi possivel iniciar o servidor de callback local em processo separado. {0}', error instanceof Error ? error.message : String(error)));
		}

		let worker: IUtilityProcessWorkerHandle;
		try {
			worker = await utilityProcessService.createWorker({
				moduleId: OPENAI_OAUTH_LOOPBACK_WORKER_MODULE_ID,
				type: 'oauthLoopback',
				name: 'NeoCode OpenAI OAuth Callback'
			});
		} catch (error) {
			throw new Error(localize('neoSwarm.oauth.loopback.createWorkerFailed', 'Nao foi possivel iniciar o processo de callback local. {0}', error instanceof Error ? error.message : String(error)));
		}
		const loopbackService = ProxyChannel.toService<IOpenAILoopbackCallbackServerService>(worker.client.getChannel(NEO_SWARM_OPENAI_LOOPBACK_CHANNEL));
		const redirect = new URL(OPENAI_OAUTH_REDIRECT_URI);
		const port = Number(redirect.port || '80');
		const path = redirect.pathname || '/';

		try {
			await loopbackService.start({
				host: redirect.hostname,
				port,
				path,
				expectedState,
				timeoutMs: OPENAI_OAUTH_CALLBACK_TIMEOUT_MS
			});
		} catch (error) {
			worker.dispose();
			throw new Error(localize('neoSwarm.oauth.loopback.startFailed', 'Nao foi possivel iniciar callback local em {0}. Erro: {1}', OPENAI_OAUTH_REDIRECT_URI, error instanceof Error ? error.message : String(error)));
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
		const redirect = new URL(OPENAI_OAUTH_REDIRECT_URI);
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
		return new URLSearchParams(parsed.query).get('nonce') === nonce;
	}

	private async promptManualCallback(expectedNonce: string, reason?: string, redirectUri?: string): Promise<URI> {
		const displayRedirect = redirectUri ?? OPENAI_OAUTH_REDIRECT_URI;
		const pickManual = await this.dialogService.confirm({
			type: 'info',
			message: localize('neoSwarm.oauth.manual.title', 'Continue o login no navegador e volte para concluir.'),
			detail: reason
				? localize('neoSwarm.oauth.manual.detailReason', '{0}', reason)
				: localize('neoSwarm.oauth.manual.detail', 'Cole a URL final (ou apenas o codigo) para finalizar a autenticacao.'),
			primaryButton: localize('neoSwarm.oauth.manual.primary', 'Colar URL/Codigo')
		});
		if (!pickManual.confirmed) {
			throw new Error(localize('neoSwarm.oauth.cancelled', 'Login cancelado.'));
		}

		const value = await this.quickInputService.input({
			prompt: localize('neoSwarm.oauth.manual.prompt', 'Cole a URL completa (ou somente o parametro code)'),
			placeHolder: `${displayRedirect}?code=...&state=...`,
			validateInput: async input => {
				const trimmed = input.trim();
				if (!trimmed) {
					return localize('neoSwarm.oauth.manual.required', 'Informe a URL de retorno ou o codigo.');
				}
				if (!trimmed.includes('://')) {
					return undefined;
				}
				const parsed = tryParseUri(trimmed);
				if (!parsed) {
					return localize('neoSwarm.oauth.manual.invalidUrl', 'URL invalida.');
				}
				const params = new URLSearchParams(parsed.query);
				if (!params.get('code')) {
					return localize('neoSwarm.oauth.manual.codeMissing', 'A URL precisa conter o parametro code.');
				}
				const state = params.get('state');
				if (state && !this.stateMatchesNonce(state, expectedNonce)) {
					return localize('neoSwarm.oauth.manual.stateInvalid', 'State invalido. Reinicie o login.');
				}
				return undefined;
			}
		});
		if (!value?.trim()) {
			throw new Error(localize('neoSwarm.oauth.cancelled', 'Login cancelado.'));
		}
		const trimmed = value.trim();
		if (!trimmed.includes('://')) {
			return URI.from({
				scheme: 'neocode',
				authority: 'manual',
				path: '/oauth',
				query: `code=${encodeURIComponent(trimmed)}&state=${encodeURIComponent(`nonce=${expectedNonce}`)}`
			});
		}
		const parsed = tryParseUri(trimmed);
		if (!parsed) {
			throw new Error(localize('neoSwarm.oauth.manual.invalidUrl', 'URL invalida.'));
		}
		return parsed;
	}

	private async exchangeCodeForToken(code: string, codeVerifier: string, redirectUri: string): Promise<IOpenAITokenBundle> {
		const payload = await exchangeOpenAICodeForToken(code, codeVerifier, redirectUri);
		if (!payload.access_token) {
			throw new Error(localize('neoSwarm.oauth.invalidTokenPayload', 'Resposta de token invalida.'));
		}

		const missingScopes = getMissingOpenAIScopes(payload.scope);

		return {
			accessToken: payload.access_token,
			refreshToken: payload.refresh_token,
			tokenType: payload.token_type,
			scope: payload.scope,
			expiresAt: payload.expires_in ? Date.now() + (payload.expires_in * 1000) : undefined,
			missingScopes
		};
	}

	private generateRandomString(length: number): string {
		const bytes = new Uint8Array(length);
		crypto.getRandomValues(bytes);
		return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('').slice(0, length);
	}

	private async generateCodeChallenge(codeVerifier: string): Promise<string> {
		const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
		let binary = '';
		for (const byte of new Uint8Array(digest)) {
			binary += String.fromCharCode(byte);
		}
		return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	}
}

interface IOpenAITokenResponse {
		access_token?: string;
		refresh_token?: string;
		token_type?: string;
		scope?: string;
		expires_in?: number;
}

async function exchangeOpenAICodeForToken(code: string, codeVerifier: string, redirectUri: string): Promise<IOpenAITokenResponse> {
	const body = new URLSearchParams();
	body.set('client_id', OPENAI_OAUTH_CLIENT_ID);
	body.set('grant_type', 'authorization_code');
	body.set('code', code);
	body.set('redirect_uri', redirectUri);
	body.set('code_verifier', codeVerifier);

	const response = await fetch(OPENAI_OAUTH_TOKEN_URL, {
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
			? localize('neoSwarm.oauth.tokenExchangeFailedDetailed', 'Falha ao trocar codigo por token (HTTP {0}): {1}', response.status, detail)
			: localize('neoSwarm.oauth.tokenExchangeFailed', 'Falha ao trocar codigo por token (HTTP {0}).', response.status));
	}

	return response.json() as Promise<IOpenAITokenResponse>;
}

function tryParseUri(value: string): URI | undefined {
	try {
		return URI.parse(value);
	} catch {
		return undefined;
	}
}

function getMissingOpenAIScopes(scopeValue: string | undefined): string[] {
	if (!scopeValue?.trim()) {
		return [...REQUIRED_OPENAI_SCOPES];
	}
	const grantedScopes = new Set(scopeValue.split(/\s+/).map(scope => scope.trim()).filter(Boolean));
	return REQUIRED_OPENAI_SCOPES.filter(scope => !grantedScopes.has(scope));
}

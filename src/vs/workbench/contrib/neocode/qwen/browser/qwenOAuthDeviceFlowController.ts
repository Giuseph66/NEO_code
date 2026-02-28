/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { IChannel, ProxyChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { localize } from '../../../../../nls.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import {
	IQwenOAuthWorkerService,
	NEO_QWEN_OAUTH_WORKER_CHANNEL
} from '../common/qwenOAuthWorkerTypes.js';

// ─── Qwen OAuth Constants ────────────────────────────────────────────────────
const QWEN_OAUTH_BASE_URL = 'https://chat.qwen.ai';
const QWEN_OAUTH_DEVICE_CODE_ENDPOINT = `${QWEN_OAUTH_BASE_URL}/api/v1/oauth2/device/code`;
const QWEN_OAUTH_TOKEN_ENDPOINT = `${QWEN_OAUTH_BASE_URL}/api/v1/oauth2/token`;
const QWEN_OAUTH_CLIENT_ID = 'f0304373b74a44d2b584a3fb70ca9e56';
const QWEN_OAUTH_SCOPE = 'openid profile email model.completion';
const QWEN_OAUTH_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

const QWEN_OAUTH_WORKER_MODULE_ID = 'vs/workbench/contrib/neocode/qwen/node/qwenOAuthWorkerMain';

// ─── Credential File Path ────────────────────────────────────────────────────
const QWEN_CRED_DIR = '.qwen';
const QWEN_CRED_FILE = 'oauth_creds.json';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface IQwenOAuthCredentials {
	access_token?: string;
	refresh_token?: string;
	id_token?: string;
	expiry_date?: number;
	token_type?: string;
	resource_url?: string;
}

export interface IQwenDeviceAuthData {
	device_code: string;
	user_code: string;
	verification_uri: string;
	verification_uri_complete: string;
	expires_in: number;
}

export interface IQwenDeviceFlowProgress {
	stage: 'requesting' | 'waiting' | 'polling' | 'success' | 'error' | 'cancelled' | 'timeout';
	message: string;
	verificationUri?: string;
	userCode?: string;
	attempt?: number;
	maxAttempts?: number;
}

export interface IQwenDeviceFlowResult {
	ok: boolean;
	message: string;
	credentials?: IQwenOAuthCredentials;
}

// ─── PKCE (Browser-compatible using Web Crypto API) ──────────────────────────

function generateCodeVerifier(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return base64UrlEncode(bytes);
}

async function generateCodeChallenge(codeVerifier: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(codeVerifier);
	const digest = await crypto.subtle.digest('SHA-256', data);
	return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(buffer: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < buffer.length; i++) {
		binary += String.fromCharCode(buffer[i]);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function objectToUrlEncoded(data: Record<string, string>): string {
	return Object.entries(data)
		.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
		.join('&');
}

function generateRequestId(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

// ─── Utility Process Worker Handle ───────────────────────────────────────────

interface IUtilityProcessWorkerHandle {
	client: { getChannel(channelName: string): IChannel };
	dispose(): void;
}

interface IUtilityProcessWorkerServiceLike {
	createWorker(process: { moduleId: string; type: string; name: string }): Promise<IUtilityProcessWorkerHandle>;
}

// ─── Controller ──────────────────────────────────────────────────────────────

/**
 * Qwen OAuth Device Flow Controller.
 * Routes HTTP requests through a Node.js utility process worker
 * to bypass browser CORS restrictions.
 */
export class QwenOAuthDeviceFlowController extends Disposable {

	private _cancelSource: CancellationTokenSource | undefined;

	constructor(
		private readonly instantiationService: IInstantiationService,
		private readonly fileService: IFileService,
		private readonly openerService: IOpenerService,
		private readonly pathService: IPathService,
	) {
		super();
	}

	cancel(): void {
		this._cancelSource?.cancel();
	}

	override dispose(): void {
		this._cancelSource?.cancel();
		this._cancelSource?.dispose(true);
		this._cancelSource = undefined;
		super.dispose();
	}

	/**
	 * Run the full device code flow using a utility process worker for HTTP requests.
	 */
	async startDeviceFlow(onProgress?: (progress: IQwenDeviceFlowProgress) => void): Promise<IQwenDeviceFlowResult> {
		const cancelSource = new CancellationTokenSource();
		this._cancelSource = cancelSource;
		const token = cancelSource.token;

		// Start the utility process worker for CORS-free HTTP requests
		let worker: IUtilityProcessWorkerHandle | undefined;
		let workerService: IQwenOAuthWorkerService;

		try {
			onProgress?.({
				stage: 'requesting',
				message: localize('neocode.qwen.deviceFlow.starting', 'Iniciando processo de autenticacao...'),
			});

			const result = await this.startWorker();
			worker = result.worker;
			workerService = result.service;
		} catch (error) {
			cancelSource.dispose();
			this._cancelSource = undefined;
			const msg = error instanceof Error ? error.message : String(error);
			onProgress?.({ stage: 'error', message: msg });
			return { ok: false, message: msg };
		}

		try {
			// 1. Generate PKCE pair
			onProgress?.({
				stage: 'requesting',
				message: localize('neocode.qwen.deviceFlow.generatingPkce', 'Gerando PKCE...'),
			});

			const codeVerifier = generateCodeVerifier();
			const codeChallenge = await generateCodeChallenge(codeVerifier);

			// 2. Request device authorization via worker
			onProgress?.({
				stage: 'requesting',
				message: localize('neocode.qwen.deviceFlow.requestingDeviceCode', 'Solicitando codigo de dispositivo ao Qwen...'),
			});

			const deviceAuth = await this.requestDeviceAuthorization(workerService, codeChallenge);

			// 3. Report URL and user_code to UI
			onProgress?.({
				stage: 'waiting',
				message: localize('neocode.qwen.deviceFlow.openBrowser', 'Abra a URL no navegador e autorize com o codigo: {0}', deviceAuth.user_code),
				verificationUri: deviceAuth.verification_uri_complete,
				userCode: deviceAuth.user_code,
			});

			// Open the verification URL in the default browser
			try {
				await this.openerService.open(URI.parse(deviceAuth.verification_uri_complete), {
					openExternal: true,
					allowContributedOpeners: false,
				});
			} catch {
				// User still has the URL from the progress callback
			}

			// 4. Poll for token via worker
			const credentials = await this.pollForToken(workerService, deviceAuth, codeVerifier, token, onProgress);

			// 5. Save credentials
			await this.cacheCredentials(credentials);

			onProgress?.({
				stage: 'success',
				message: localize('neocode.qwen.deviceFlow.success', 'Login Qwen OAuth concluido com sucesso!'),
			});

			return {
				ok: true,
				message: localize('neocode.qwen.deviceFlow.successResult', 'Qwen OAuth conectado com sucesso. Credenciais salvas em ~/.qwen/.'),
				credentials,
			};
		} catch (error) {
			if (token.isCancellationRequested) {
				onProgress?.({
					stage: 'cancelled',
					message: localize('neocode.qwen.deviceFlow.cancelled', 'Login cancelado pelo usuario.'),
				});
				return { ok: false, message: localize('neocode.qwen.deviceFlow.cancelledResult', 'Login Qwen OAuth cancelado.') };
			}
			const errorMessage = error instanceof Error ? error.message : String(error);
			onProgress?.({ stage: 'error', message: errorMessage });
			return { ok: false, message: errorMessage };
		} finally {
			this._cancelSource = undefined;
			cancelSource.dispose();
			worker?.dispose();
		}
	}

	async refreshAccessToken(refreshToken: string): Promise<IQwenDeviceFlowResult> {
		const cancelSource = new CancellationTokenSource();
		this._cancelSource = cancelSource;
		let worker: IUtilityProcessWorkerHandle | undefined;
		let workerService: IQwenOAuthWorkerService | undefined;

		try {
			const result = await this.startWorker();
			worker = result.worker;
			workerService = result.service;

			const bodyData = {
				grant_type: 'refresh_token',
				refresh_token: refreshToken,
				client_id: QWEN_OAUTH_CLIENT_ID,
			};

			const response = await workerService.post({
				url: QWEN_OAUTH_TOKEN_ENDPOINT,
				body: objectToUrlEncoded(bodyData),
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					Accept: 'application/json',
				},
			});

			if (response.statusCode >= 200 && response.statusCode < 300) {
				const tokenData = JSON.parse(response.body) as {
					access_token?: string;
					refresh_token?: string;
					token_type?: string;
					expires_in?: number;
					resource_url?: string;
				};

				if (tokenData.access_token) {
					const credentials = {
						access_token: tokenData.access_token,
						refresh_token: tokenData.refresh_token ?? refreshToken,
						token_type: tokenData.token_type,
						resource_url: tokenData.resource_url,
						expiry_date: tokenData.expires_in ? Date.now() + tokenData.expires_in * 1000 : undefined,
					};

					await this.cacheCredentials(credentials);

					return {
						ok: true,
						message: localize('neocode.qwen.deviceFlow.refreshSuccess', 'Token atualizado com sucesso.'),
						credentials,
					};
				}
			}

			throw new Error(localize('neocode.qwen.deviceFlow.refreshFailed', 'Falha ao atualizar token: {0} {1}', response.statusCode, response.body));
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			return { ok: false, message: errorMessage };
		} finally {
			this._cancelSource = undefined;
			cancelSource.dispose();
			worker?.dispose();
		}
	}

	// ─── Worker Management ───────────────────────────────────────────────

	private async startWorker(): Promise<{ worker: IUtilityProcessWorkerHandle; service: IQwenOAuthWorkerService }> {
		let utilityProcessService: IUtilityProcessWorkerServiceLike;
		try {
			const module = await import('../../../../services/utilityProcess/electron-browser/utilityProcessWorkerWorkbenchService.js');
			utilityProcessService = this.instantiationService.invokeFunction(
				accessor => accessor.get(module.IUtilityProcessWorkerWorkbenchService)
			) as IUtilityProcessWorkerServiceLike;
		} catch (error) {
			throw new Error(localize(
				'neocode.qwen.deviceFlow.workerUnavailable',
				'Nao foi possivel iniciar o processo de autenticacao. {0}',
				error instanceof Error ? error.message : String(error)
			));
		}

		const worker = await utilityProcessService.createWorker({
			moduleId: QWEN_OAUTH_WORKER_MODULE_ID,
			type: 'qwenOAuth',
			name: 'NeoCode Qwen OAuth Worker',
		});

		const service = ProxyChannel.toService<IQwenOAuthWorkerService>(
			worker.client.getChannel(NEO_QWEN_OAUTH_WORKER_CHANNEL)
		);

		return { worker, service };
	}

	// ─── HTTP Requests (via worker) ──────────────────────────────────────

	private async requestDeviceAuthorization(workerService: IQwenOAuthWorkerService, codeChallenge: string): Promise<IQwenDeviceAuthData> {
		const bodyData: Record<string, string> = {
			client_id: QWEN_OAUTH_CLIENT_ID,
			scope: QWEN_OAUTH_SCOPE,
			code_challenge: codeChallenge,
			code_challenge_method: 'S256',
		};

		const result = await workerService.post({
			url: QWEN_OAUTH_DEVICE_CODE_ENDPOINT,
			body: objectToUrlEncoded(bodyData),
			headers: { 'x-request-id': generateRequestId() },
		});

		if (result.statusCode >= 400) {
			throw new Error(localize('neocode.qwen.deviceFlow.deviceCodeFailed', 'Falha ao obter codigo de dispositivo (HTTP {0}): {1}', result.statusCode, result.body));
		}

		const parsed = JSON.parse(result.body) as IQwenDeviceAuthData & { error?: string; error_description?: string };

		if (parsed.error) {
			throw new Error(localize('neocode.qwen.deviceFlow.deviceCodeError', 'Erro ao obter codigo de dispositivo: {0} - {1}', parsed.error, parsed.error_description ?? ''));
		}

		if (!parsed.device_code || !parsed.verification_uri_complete) {
			throw new Error(localize('neocode.qwen.deviceFlow.deviceCodeInvalid', 'Resposta de device code invalida.'));
		}

		return parsed;
	}

	private async pollForToken(
		workerService: IQwenOAuthWorkerService,
		deviceAuth: IQwenDeviceAuthData,
		codeVerifier: string,
		cancelToken: { isCancellationRequested: boolean },
		onProgress?: (progress: IQwenDeviceFlowProgress) => void,
	): Promise<IQwenOAuthCredentials> {
		let pollInterval = 2000;
		const maxAttempts = Math.ceil(deviceAuth.expires_in / (pollInterval / 1000));

		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			if (cancelToken.isCancellationRequested) {
				throw new Error('cancelled');
			}

			onProgress?.({
				stage: 'polling',
				message: localize('neocode.qwen.deviceFlow.polling', 'Aguardando autorizacao... ({0}/{1})', attempt + 1, maxAttempts),
				verificationUri: deviceAuth.verification_uri_complete,
				userCode: deviceAuth.user_code,
				attempt: attempt + 1,
				maxAttempts,
			});

			try {
				const bodyData: Record<string, string> = {
					grant_type: QWEN_OAUTH_GRANT_TYPE,
					client_id: QWEN_OAUTH_CLIENT_ID,
					device_code: deviceAuth.device_code,
					code_verifier: codeVerifier,
				};

				const result = await workerService.post({
					url: QWEN_OAUTH_TOKEN_ENDPOINT,
					body: objectToUrlEncoded(bodyData),
				});

				if (result.statusCode >= 400) {
					let errorData: { error?: string; error_description?: string } | null = null;
					try { errorData = JSON.parse(result.body); } catch { /* not JSON */ }

					if (result.statusCode === 400 && errorData?.error === 'authorization_pending') {
						await this.waitWithCancellation(pollInterval, cancelToken);
						continue;
					}

					if (result.statusCode === 429 && errorData?.error === 'slow_down') {
						pollInterval = Math.min(pollInterval * 1.5, 10000);
						await this.waitWithCancellation(pollInterval, cancelToken);
						continue;
					}

					if (result.statusCode === 401) {
						throw new Error(localize('neocode.qwen.deviceFlow.expired', 'Codigo de dispositivo expirou. Reinicie o processo.'));
					}

					if (result.statusCode === 429) {
						throw new Error(localize('neocode.qwen.deviceFlow.rateLimit', 'Muitas requisicoes. Tente novamente mais tarde.'));
					}

					throw new Error(localize('neocode.qwen.deviceFlow.pollError', 'Erro ao verificar autorizacao (HTTP {0}): {1}', result.statusCode, errorData?.error_description ?? result.body));
				}

				const tokenData = JSON.parse(result.body) as {
					access_token?: string;
					refresh_token?: string;
					token_type?: string;
					expires_in?: number;
					resource_url?: string;
				};

				if (!tokenData.access_token) {
					await this.waitWithCancellation(pollInterval, cancelToken);
					continue;
				}

				return {
					access_token: tokenData.access_token,
					refresh_token: tokenData.refresh_token ?? undefined,
					token_type: tokenData.token_type,
					resource_url: tokenData.resource_url,
					expiry_date: tokenData.expires_in ? Date.now() + tokenData.expires_in * 1000 : undefined,
				};
			} catch (error) {
				if (cancelToken.isCancellationRequested) { throw error; }
				const msg = error instanceof Error ? error.message : String(error);
				if (msg.includes('expirou') || msg.includes('expired') || msg.includes('Muitas requisicoes')) { throw error; }
				await this.waitWithCancellation(pollInterval, cancelToken);
			}
		}

		throw new Error(localize('neocode.qwen.deviceFlow.timeout', 'Timeout ao aguardar autorizacao. Reinicie o processo.'));
	}

	// ─── Utilities ───────────────────────────────────────────────────────

	private async waitWithCancellation(ms: number, cancelToken: { isCancellationRequested: boolean }): Promise<void> {
		const checkInterval = 100;
		let elapsed = 0;
		while (elapsed < ms) {
			if (cancelToken.isCancellationRequested) { throw new Error('cancelled'); }
			await new Promise<void>(resolve => setTimeout(resolve, checkInterval));
			elapsed += checkInterval;
		}
	}

	private async cacheCredentials(credentials: IQwenOAuthCredentials): Promise<void> {
		const userHomeUri = await this.pathService.userHome();
		const dirUri = URI.joinPath(userHomeUri, QWEN_CRED_DIR);
		const fileUri = URI.joinPath(dirUri, QWEN_CRED_FILE);
		try {
			await this.fileService.createFolder(dirUri);
			await this.fileService.writeFile(fileUri, VSBuffer.fromString(JSON.stringify(credentials, null, 2)));
		} catch (error) {
			throw new Error(localize(
				'neocode.qwen.deviceFlow.cacheCredsFailed',
				'Falha ao salvar credenciais OAuth em ~/.qwen/oauth_creds.json: {0}',
				error instanceof Error ? error.message : String(error),
			));
		}
	}
}

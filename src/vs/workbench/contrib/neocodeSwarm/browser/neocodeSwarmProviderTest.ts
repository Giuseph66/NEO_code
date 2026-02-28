/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { INeocodeSwarmProviderConfig } from '../common/neocodeSwarmTypes.js';
import { isOpenAITokenExpiredOrNearExpiry, parseStoredOpenAITokenBundle } from './neocodeSwarmOpenAIOAuthController.js';

export interface IProviderTestResult {
	ok: boolean;
	message: string;
}

export class NeocodeSwarmProviderTest {
	async testConnection(provider: INeocodeSwarmProviderConfig, secret: string | undefined): Promise<IProviderTestResult> {
		switch (provider.authMethod) {
			case 'apiKey':
				return this.testApiKeyProvider(provider, secret);
			case 'login':
				if (!secret?.trim()) {
					return { ok: false, message: localize('neoSwarm.loginMissing', "Nenhum token de login encontrado. Conecte primeiro.") };
				}
				if (provider.type === 'openai') {
					return this.testOpenAILoginToken(secret);
				}
				return { ok: true, message: localize('neoSwarm.loginStored', "Token de login salvo no armazenamento seguro.") };
			case 'cliToken':
				return { ok: true, message: localize('neoSwarm.cliAuthMode', "Modo de autenticacao por CLI habilitado. Teste na Ponte CLI.") };
			case 'qwen-oauth':
				return { ok: true, message: localize('neoSwarm.qwenOAuthMode', "Qwen OAuth via CLI configurado. Use o painel dedicado do Qwen para testar conexao.") };
			default:
				return { ok: false, message: localize('neoSwarm.authUnsupported', "Metodo de autenticacao nao suportado para este provedor.") };
		}
	}

	private async testApiKeyProvider(provider: INeocodeSwarmProviderConfig, apiKey: string | undefined): Promise<IProviderTestResult> {
		if (!apiKey?.trim()) {
			return { ok: false, message: localize('neoSwarm.apiKeyMissing', "API Key obrigatoria.") };
		}

		if (provider.type === 'custom' && !provider.baseUrl?.trim()) {
			return { ok: false, message: localize('neoSwarm.customBaseUrlMissing', "URL base obrigatoria para este modelo.") };
		}

		try {
			const request = this.buildRequest(provider, apiKey.trim());
			if (!request) {
				return { ok: true, message: localize('neoSwarm.providerReady', "As credenciais do modelo parecem validas.") };
			}

			const controller = new AbortController();
			const timeoutHandle = setTimeout(() => controller.abort(), 10000);
			try {
				const response = await fetch(request.url, {
					method: request.method,
					headers: request.headers,
					signal: controller.signal
				});
				if (response.ok) {
					return { ok: true, message: localize('neoSwarm.providerConnected', "Conectado.") };
				}
				return { ok: false, message: localize('neoSwarm.providerHttpError', "Falha na conexao: HTTP {0}", response.status) };
			} finally {
				clearTimeout(timeoutHandle);
			}
		} catch {
			return { ok: false, message: localize('neoSwarm.providerNetworkError', "Falha na conexao. Verifique rede, URL ou credenciais.") };
		}
	}

	private async testOpenAILoginToken(tokenPayload: string): Promise<IProviderTestResult> {
		const parsed = parseStoredOpenAITokenBundle(tokenPayload);
		if (!parsed?.accessToken?.trim()) {
			return { ok: false, message: localize('neoSwarm.openaiLoginInvalidToken', "Token OAuth OpenAI invalido. Reconecte sua conta ChatGPT.") };
		}
		if (isOpenAITokenExpiredOrNearExpiry(parsed, 0) && !parsed.refreshToken?.trim()) {
			return { ok: false, message: localize('neoSwarm.openaiLoginExpiredToken', "Token OAuth OpenAI expirado e sem refresh_token. Reconecte sua conta ChatGPT.") };
		}
		return {
			ok: true,
			message: localize('neoSwarm.openaiLoginStoredIntegrated', "Conta ChatGPT conectada. O envio usa OAuth do ChatGPT via endpoint Codex (sem API key).")
		};
	}

	private buildRequest(provider: INeocodeSwarmProviderConfig, apiKey: string): { url: string; method: 'GET'; headers: Record<string, string> } | undefined {
		switch (provider.type) {
			case 'gemini':
				return {
					url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
					method: 'GET',
					headers: {}
				};
			case 'openai':
				return {
					url: `${normalizeBaseUrl(provider.baseUrl ?? 'https://api.openai.com')}/v1/models`,
					method: 'GET',
					headers: {
						Authorization: `Bearer ${apiKey}`
					}
				};
			case 'anthropic':
				return {
					url: `${normalizeBaseUrl(provider.baseUrl ?? 'https://api.anthropic.com')}/v1/models`,
					method: 'GET',
					headers: {
						'x-api-key': apiKey,
						'anthropic-version': '2023-06-01'
					}
				};
			case 'custom':
				return {
					url: `${normalizeBaseUrl(provider.baseUrl!)}${provider.baseUrl?.includes('/v1') ? '' : '/v1'}/models`,
					method: 'GET',
					headers: {
						Authorization: `Bearer ${apiKey}`
					}
				};
			default:
				return undefined;
		}
	}
}

function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.trim().replace(/\/+$/, '');
}

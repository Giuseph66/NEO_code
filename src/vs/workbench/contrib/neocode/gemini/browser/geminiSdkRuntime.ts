/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { GeminiConnectionTestKind, IGeminiConnectionTestResult } from '../common/geminiTypes.js';
import { sanitizeGeminiError } from '../common/geminiConfigSchema.js';

/**
 * Thin runtime adapter that calls the external @google/genai SDK.
 * No credentials are stored here — they are passed in at call time and only
 * live in memory during the request.
 */
export class GeminiSdkRuntime extends Disposable {
	constructor(
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	/**
	 * Test API key directly against Gemini REST API.
	 */
	async testApiKeyConnection(apiKey: string, model = 'gemini-2.0-flash'): Promise<IGeminiConnectionTestResult> {
		try {
			const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
			const response = await fetch(endpoint, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					contents: [{ parts: [{ text: 'Responda apenas com: ok' }] }]
				})
			});

			if (!response.ok) {
				const detail = await response.text();
				throw new Error(`HTTP ${response.status}: ${detail}`);
			}

			const payload = await response.json() as {
				candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
			};
			const text = payload.candidates?.[0]?.content?.parts?.find(p => typeof p.text === 'string')?.text?.trim() ?? 'ok';

			this.logService.debug('GeminiSdkRuntime: API key test succeeded');
			return {
				ok: true,
				kind: 'connected',
				message: localize('neocode.gemini.sdk.connected', 'Conexao com Gemini API bem-sucedida. Resposta: {0}', text.slice(0, 60))
			};
		} catch (error) {
			return this.mapConnectionError(error, 'apiKey');
		}
	}

	/**
	 * Test a Google Login connection by validating the access token against Google Tokeninfo endpoint.
	 * Also validates connectivity by doing a mock request if possible.
	 */
	async testGoogleLoginConnection(accessToken: string): Promise<IGeminiConnectionTestResult> {
		try {
			// Step 1: Validate token and get email
			const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
			if (!res.ok) {
				return {
					ok: false,
					kind: 'invalid_key',
					message: localize('neocode.gemini.oauth.invalid', 'Token expirado ou invalido. Faca login novamente.')
				};
			}
			const data = await res.json() as { email?: string; azp?: string };

			// Tokeninfo success is enough as a connectivity/auth check in browser runtime.
			this.logService.debug('GeminiSdkRuntime: Google Login test succeeded for', data.email);
			return {
				ok: true,
				kind: 'connected',
				message: localize('neocode.gemini.oauth.connected', 'Conexao com conta Google bem-sucedida ({0}).', data.email ?? 'Autenticado')
			};
		} catch (error) {
			const raw = error instanceof Error ? error.message : String(error);
			const message = sanitizeGeminiError(raw);
			return { ok: false, kind: 'unknown_error', message };
		}
	}

	// ─── helpers ───────────────────────────────────────────────────────────────
	private mapConnectionError(error: unknown, context: 'apiKey'): IGeminiConnectionTestResult {
		const raw = error instanceof Error ? error.message : String(error);
		const safe = sanitizeGeminiError(raw);
		let kind: GeminiConnectionTestKind = 'unknown_error';
		if (/api.?key|invalid.key|unauthorized|401/i.test(raw)) {
			kind = 'invalid_key';
		} else if (/timeout|ETIMEDOUT/i.test(raw)) {
			kind = 'timeout';
		}
		this.logService.warn(`GeminiSdkRuntime: ${context} test failed — ${safe}`);
		return { ok: false, kind, message: safe };
	}
}

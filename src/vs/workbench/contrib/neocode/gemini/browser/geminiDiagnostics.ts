/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../../nls.js';
import { IGeminiDiagnostics, IGeminiProviderConfig } from '../common/geminiTypes.js';

/**
 * Pure function that assembles a diagnostics object from config.
 * Detects common configuration conflicts and provides actionable suggestions.
 */
export function buildGeminiDiagnostics(
	config: IGeminiProviderConfig,
	secretsPresent: {
		hasGeminiApiKey: boolean;
		hasGoogleApiKey: boolean;
		hasServiceAccount: boolean;
		hasOAuthTokens: boolean;
	}
): IGeminiDiagnostics {
	const conflicts: string[] = [];
	const issues: string[] = [];
	const suggestions: string[] = [];

	// ── Conflict: both API key env vars active at the same time ──────────────
	if (secretsPresent.hasGeminiApiKey && secretsPresent.hasGoogleApiKey) {
		conflicts.push(localize(
			'neocode.gemini.diag.bothApiKeys',
			'GEMINI_API_KEY e GOOGLE_API_KEY estao ambos definidos. GOOGLE_API_KEY tem precedencia. Escolha apenas um.'
		));
		suggestions.push(localize(
			'neocode.gemini.diag.bothApiKeysFix',
			'Na aba API Key, escolha qual variavel deve ser injetada e remova a outra.'
		));
	}

	// ── Google Login in headless environment ──────────────────────────────────
	if (config.authType === 'googleLogin' && !secretsPresent.hasOAuthTokens) {
		issues.push(localize(
			'neocode.gemini.diag.loginPending',
			'Login com Google selecionado, mas nenhum token de sessao encontrado.'
		));
		suggestions.push(localize(
			'neocode.gemini.diag.loginPendingFix',
			'Conclua o login na aba "Login com Google" para gerar o token.'
		));
	}

	// ── Cloud Shell detection ─────────────────────────────────────────────────
	const isInCloudShell = typeof process !== 'undefined'
		? !!process.env['CLOUD_SHELL'] || !!process.env['GOOGLE_CLOUD_SHELL']
		: false;

	// ── settings.json path ────────────────────────────────────────────────────
	const homeDir = typeof process !== 'undefined' ? (process.env['HOME'] || process.env['USERPROFILE'] || '') : '';
	const settingsJsonPath = homeDir ? `${homeDir}/.gemini/settings.json` : undefined;

	return {
		authType: config.authType,
		modelName: config.modelName,
		apiKeyVar: config.apiKeyVar,
		hasGeminiApiKey: secretsPresent.hasGeminiApiKey,
		hasGoogleApiKey: secretsPresent.hasGoogleApiKey,
		hasServiceAccount: secretsPresent.hasServiceAccount,
		hasOAuthTokens: secretsPresent.hasOAuthTokens,
		settingsJsonPath,
		isInCloudShell,
		conflicts,
		issues,
		suggestions,
		lastConnectionStatus: config.lastConnectionStatus,
		lastConnectionMessage: config.lastConnectionMessage,
	};
}

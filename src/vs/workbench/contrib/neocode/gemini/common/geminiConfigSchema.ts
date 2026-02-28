/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IGeminiConfigExport, IGeminiProviderConfig } from './geminiTypes.js';

export function createDefaultGeminiProviderConfig(): IGeminiProviderConfig {
	return {
		authType: 'apiKey',
		modelName: 'gemini-2.5-pro',
		apiKeyVar: 'GEMINI_API_KEY',
		lastConnectionStatus: 'unknown',
		lastConnectionMessage: 'Nao testado.',
	};
}

/**
 * Strip secrets from error messages before displaying or storing them.
 * Mirrors the pattern in qwenConfigSchema.ts.
 */
export function sanitizeGeminiError(message: string): string {
	return message
		.replace(/AIza[0-9A-Za-z_-]{35}/g, 'AIza***')
		.replace(/Bearer\s+[a-zA-Z0-9._-]+/gi, 'Bearer ***')
		.replace(/(\"?(api[_-]?key|token|authorization)\"?\s*[:=]\s*\")([^"]+)(\")/gi, '$1***$4')
		.replace(/GOOGLE_API_KEY=[^\s&]+/gi, 'GOOGLE_API_KEY=***')
		.replace(/GEMINI_API_KEY=[^\s&]+/gi, 'GEMINI_API_KEY=***');
}

/**
 * Mask a secret for safe logging or UI display.
 * Shows only first 4 and last 3 characters.
 */
export function maskSecret(value: string | undefined): string {
	if (!value?.trim()) {
		return '';
	}
	const trimmed = value.trim();
	if (trimmed.length <= 8) {
		return '***';
	}
	return `${trimmed.slice(0, 4)}...${trimmed.slice(-3)}`;
}

/**
 * Build a config object safe for export (no secrets).
 */
export function toExportConfig(config: IGeminiProviderConfig): IGeminiConfigExport {
	return {
		authType: config.authType,
		modelName: config.modelName,
		googleCloudProject: config.googleCloudProject,
		apiKeyVar: config.apiKeyVar,
	};
}

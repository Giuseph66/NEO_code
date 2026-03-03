/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IQwenConfigExport, IQwenProviderConfig } from './qwenTypes.js';

export function createDefaultQwenProviderConfig(): IQwenProviderConfig {
	return {
		authType: 'apiKey',
		protocol: 'openai',
		modelId: 'qwen3-coder-plus',
		displayName: 'Qwen Code',
		envVarName: 'OPENAI_API_KEY',
		lastConnectionStatus: 'unknown',
		lastConnectionMessage: 'Nao testado.',
		credentials: [],
	};
}

export function protocolDefaultEnvVar(protocol: IQwenProviderConfig['protocol']): string {
	switch (protocol) {
		case 'anthropic': return 'ANTHROPIC_API_KEY';
		case 'gemini': return 'GEMINI_API_KEY';
		case 'vertex-ai': return 'GOOGLE_API_KEY';
		default: return 'OPENAI_API_KEY';
	}
}

export function sanitizeQwenError(message: string): string {
	return message
		.replace(/sk-[a-zA-Z0-9_-]{10,}/g, 'sk-***')
		.replace(/Bearer\s+[a-zA-Z0-9._-]+/gi, 'Bearer ***')
		.replace(/("?(api[_-]?key|token|authorization)"?\s*[:=]\s*")([^"]+)(")/gi, '$1***$4');
}

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

export function toExportConfig(config: IQwenProviderConfig): IQwenConfigExport {
	return {
		authType: config.authType,
		protocol: config.protocol,
		modelId: config.modelId,
		displayName: config.displayName,
		baseUrl: config.baseUrl,
		envVarName: config.envVarName,
		cliPathOverride: config.cliPathOverride,
		credentials: config.credentials,
		activeCredentialId: config.activeCredentialId,
	};
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';

export const NEO_QWEN_STORAGE_KEY = 'neocode.qwen.config.v1';
export const NEO_QWEN_COMMAND_OPEN_SETTINGS = 'neocode.openQwenSettings';
export const NEO_QWEN_SECRET_API_KEY = 'neocode.qwen.apiKey';

export type QwenAuthType = 'apiKey' | 'qwen-oauth';
export type QwenProtocol = 'openai' | 'anthropic' | 'gemini' | 'vertex-ai';
export type QwenCliDetectSource = 'manual' | 'env' | 'auto' | 'none';

export interface IQwenProviderConfig {
	authType: QwenAuthType;
	protocol: QwenProtocol;
	modelId: string;
	displayName: string;
	baseUrl?: string;
	envVarName: string;
	cliPathOverride?: string;
	lastConnectionStatus?: 'connected' | 'error' | 'unknown';
	lastConnectionMessage?: string;
	lastConnectionAt?: number;
}

export interface IQwenDiagnostics {
	authType: QwenAuthType;
	protocol: QwenProtocol;
	modelId: string;
	cliPath: string;
	cliPathSource: QwenCliDetectSource;
	cliDetected: boolean;
	cliVersion?: string;
	isNodeVersionCompatible?: boolean;
	hasBrokenAuthState: boolean;
	lastConnectionStatus?: string;
	issues: string[];
	suggestions: string[];
}

export interface IQwenCliInfo {
	path: string;
	source: QwenCliDetectSource;
	version?: string;
	ok: boolean;
	output?: string;
}

export interface IQwenConnectionTestResult {
	ok: boolean;
	kind: 'connected' | 'missing_key' | 'invalid_base_url' | 'invalid_model' | 'timeout' | 'sdk_unavailable' | 'cli_unavailable' | 'auth_required' | 'unknown_error';
	message: string;
}

export interface IQwenRuntimeEnvResult {
	env: Record<string, string>;
	maskedEnv: Record<string, string>;
}

export interface IQwenConfigExport {
	authType: QwenAuthType;
	protocol: QwenProtocol;
	modelId: string;
	displayName: string;
	baseUrl?: string;
	envVarName: string;
	cliPathOverride?: string;
}

export const IQwenAuthService = createDecorator<IQwenAuthService>('neocodeQwenAuthService');

export interface IQwenAuthService {
	readonly _serviceBrand: undefined;
	loadConfig(): IQwenProviderConfig;
	saveApiKeyConfig(config: Partial<IQwenProviderConfig> & { apiKey: string }): Promise<void>;
	saveOAuthSelection(config: Partial<IQwenProviderConfig>): Promise<void>;
	testApiKeyConnection(): Promise<IQwenConnectionTestResult>;
	startNativeOAuthFlow(onProgress?: (msg: string) => void): Promise<IQwenConnectionTestResult>;
	cancelNativeOAuthFlow(): void;
	detectQwenCli(): Promise<IQwenCliInfo>;
	getQwenVersion(): Promise<IQwenCliInfo>;
	resetBrokenAuthState(): Promise<void>;
	clearAllQwenCredentials(): Promise<void>;
	buildRuntimeEnv(): Promise<IQwenRuntimeEnvResult>;
	syncQwenConfig(): Promise<void>;
	getDiagnostics(): Promise<IQwenDiagnostics>;
	exportConfigWithoutSecrets(): IQwenConfigExport;
}

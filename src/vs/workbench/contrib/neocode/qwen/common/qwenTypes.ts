/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';

export const NEO_QWEN_STORAGE_KEY = 'neocode.qwen.config.v1';
export const NEO_QWEN_COMMAND_OPEN_SETTINGS = 'neocode.openQwenSettings';
export const NEO_QWEN_SECRET_API_KEY = 'neocode.qwen.apiKey';
export const NEO_QWEN_SECRET_API_KEY_PREFIX = 'neocode.qwen.apiKey.';
export const NEO_QWEN_SECRET_OAUTH_CREDENTIAL_PREFIX = 'neocode.qwen.oauthCredential.';

export type QwenAuthType = 'apiKey' | 'qwen-oauth';
export type QwenProtocol = 'openai' | 'anthropic' | 'gemini' | 'vertex-ai';
export type QwenCliDetectSource = 'manual' | 'env' | 'auto' | 'none';

export interface IQwenStoredCredential {
	id: string;
	name: string;
	authType: QwenAuthType;
	createdAt: number;
	updatedAt: number;
	lastUsedAt?: number;
}

export interface IQwenOAuthStartOptions {
	credentialId?: string;
	credentialName?: string;
	createNewCredential?: boolean;
	skipExistingCheck?: boolean;
}

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
	credentials?: IQwenStoredCredential[];
	activeCredentialId?: string;
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
	credentials?: IQwenStoredCredential[];
	activeCredentialId?: string;
}

// ─── Tool calling interfaces ──────────────────────────────────────────────────

/**
 * Describes a tool that can be called by the AI model (JSON Schema parameters).
 */
export interface INeocodeToolDefinition {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

/**
 * A single tool call made by the AI model.
 */
export interface INeocodeToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

/**
 * Result of executing a tool call.
 */
export interface INeocodeToolResult {
	id: string;
	content: string;
	isError?: boolean;
}

/**
 * Executes tool calls on behalf of the AI model (implemented by the swarm layer).
 */
export interface INeocodeToolExecutor {
	getTools(): INeocodeToolDefinition[];
	execute(call: INeocodeToolCall): Promise<INeocodeToolResult>;
}

// ─── Auth service ─────────────────────────────────────────────────────────────

export const IQwenAuthService = createDecorator<IQwenAuthService>('neocodeQwenAuthService');

export interface IQwenAuthService {
	readonly _serviceBrand: undefined;
	loadConfig(): IQwenProviderConfig;
	saveApiKeyConfig(config: Partial<IQwenProviderConfig> & { apiKey: string; credentialId?: string; credentialName?: string; createNewCredential?: boolean }): Promise<void>;
	saveOAuthSelection(config: Partial<IQwenProviderConfig>): Promise<void>;
	testApiKeyConnection(): Promise<IQwenConnectionTestResult>;
	startNativeOAuthFlow(onProgress?: (msg: string) => void, options?: IQwenOAuthStartOptions): Promise<IQwenConnectionTestResult>;
	cancelNativeOAuthFlow(): void;
	listCredentials(): IQwenStoredCredential[];
	setActiveCredential(credentialId: string): Promise<void>;
	removeCredential(credentialId: string): Promise<void>;
	detectQwenCli(): Promise<IQwenCliInfo>;
	getQwenVersion(): Promise<IQwenCliInfo>;
	resetBrokenAuthState(): Promise<void>;
	clearAllQwenCredentials(): Promise<void>;
	buildRuntimeEnv(): Promise<IQwenRuntimeEnvResult>;
	syncQwenConfig(): Promise<void>;
	getDiagnostics(): Promise<IQwenDiagnostics>;
	exportConfigWithoutSecrets(): IQwenConfigExport;
}

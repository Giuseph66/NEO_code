/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';

// ─── Storage / Secret keys ────────────────────────────────────────────────────
export const NEO_GEMINI_STORAGE_KEY = 'neocode.gemini.config.v1';
export const NEO_GEMINI_SECRET_API_KEY = 'neocode.gemini.apiKey';
export const NEO_GEMINI_SECRET_GOOGLE_API_KEY = 'neocode.gemini.googleApiKey';
export const NEO_GEMINI_SECRET_SERVICE_ACCOUNT = 'neocode.gemini.serviceAccount';
export const NEO_GEMINI_SECRET_OAUTH_TOKENS = 'neocode.gemini.oauthTokens';
export const NEO_GEMINI_COMMAND_OPEN_SETTINGS = 'neocode.openGeminiSettings';
// ─── Discriminated union types ────────────────────────────────────────────────
/** Two official Gemini CLI / SDK auth paths in NeoCode. */
export type GeminiAuthType = 'apiKey' | 'googleLogin';



/**
 * Which API key env var the user wants NeoCode to inject.
 * GOOGLE_API_KEY takes precedence if both are defined — so we warn the user
 * and only inject one at a time.
 */
export type GeminiApiKeyVar = 'GEMINI_API_KEY' | 'GOOGLE_API_KEY';

// ─── Config ───────────────────────────────────────────────────────────────────
export interface IGeminiProviderConfig {
	authType: GeminiAuthType;
	/** Default model name (e.g. "gemini-2.5-pro") */
	modelName: string;
	// Google Login
	googleCloudProject?: string;
	/** Which env var name to inject the Gemini API key as */
	apiKeyVar: GeminiApiKeyVar;
	// Diagnostic / status tracking
	lastConnectionStatus?: 'connected' | 'error' | 'unknown';
	lastConnectionMessage?: string;
	lastConnectionAt?: number;
}

// ─── Diagnostics ─────────────────────────────────────────────────────────────
export interface IGeminiDiagnostics {
	authType: GeminiAuthType;
	modelName: string;
	apiKeyVar: GeminiApiKeyVar;
	email?: string;
	hasGeminiApiKey: boolean;
	hasGoogleApiKey: boolean;
	hasServiceAccount: boolean;
	hasOAuthTokens?: boolean;
	settingsJsonPath?: string;
	securityAuthSelectedType?: string;
	isInCloudShell: boolean;
	conflicts: string[];
	issues: string[];
	suggestions: string[];
	lastConnectionStatus?: string;
	lastConnectionMessage?: string;
}


// ─── Connection test result ───────────────────────────────────────────────────
export type GeminiConnectionTestKind =
	| 'connected'
	| 'missing_key'
	| 'missing_project'
	| 'missing_location'
	| 'invalid_key'
	| 'timeout'
	| 'sdk_unavailable'
	| 'auth_required'
	| 'conflict'
	| 'unknown_error';

export interface IGeminiConnectionTestResult {
	ok: boolean;
	kind: GeminiConnectionTestKind;
	message: string;
}

// ─── Runtime env ─────────────────────────────────────────────────────────────
export interface IGeminiRuntimeEnvResult {
	/** Actual env vars to inject — NEVER log these. */
	env: Record<string, string>;
	/** Masked version safe for logs / UI display. */
	maskedEnv: Record<string, string>;
}

// ─── Config export (no secrets) ──────────────────────────────────────────────
export interface IGeminiConfigExport {
	authType: GeminiAuthType;
	modelName: string;
	googleCloudProject?: string;
	apiKeyVar: GeminiApiKeyVar;
}

// ─── Service interface ────────────────────────────────────────────────────────
export const IGeminiAuthService = createDecorator<IGeminiAuthService>('neocodeGeminiAuthService');

export interface IGeminiAuthService {
	readonly _serviceBrand: undefined;

	loadConfig(): IGeminiProviderConfig;
	saveApiKeyConfig(config: Partial<IGeminiProviderConfig> & { apiKey: string }): Promise<void>;
	saveGoogleLoginPreference(config: Partial<IGeminiProviderConfig>): Promise<void>;

	startNativeGoogleLoginFlow(): Promise<IGeminiConnectionTestResult>;

	testApiKeyConnection(): Promise<IGeminiConnectionTestResult>;
	testGoogleLoginConnection(): Promise<IGeminiConnectionTestResult>;

	buildRuntimeEnv(): Promise<IGeminiRuntimeEnvResult>;
	clearAllGeminiCredentials(): Promise<void>;
	getDiagnostics(): Promise<IGeminiDiagnostics>;
	exportConfigWithoutSecrets(): IGeminiConfigExport;
}

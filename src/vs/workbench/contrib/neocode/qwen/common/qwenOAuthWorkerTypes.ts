/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../../base/common/event.js';

// ─── IPC Channel Name ─────────────────────────────────────────────────────────
export const NEO_QWEN_OAUTH_WORKER_CHANNEL = 'neocodeQwenOAuthWorker';

// ─── Request / Response types for the worker ──────────────────────────────────

export interface IQwenOAuthWorkerPostOptions {
	url: string;
	body: string;
	headers?: Record<string, string>;
}

export interface IQwenOAuthWorkerPostMultipartBase64Options {
	url: string;
	fileBase64: string;
	fileName: string;
	fileMimeType: string;
	fields?: Record<string, string>;
	headers?: Record<string, string>;
}

export interface IQwenOAuthWorkerPostResult {
	statusCode: number;
	body: string;
}

export interface IQwenOAuthWorkerStreamChunk {
	type: 'data' | 'error' | 'done';
	data?: string;
	error?: string;
}

// ─── Service interface (browser ↔ worker IPC) ────────────────────────────────

export interface IQwenOAuthWorkerService {
	/**
	 * Make a POST request from the Node.js process (no CORS restrictions).
	 */
	post(options: IQwenOAuthWorkerPostOptions): Promise<IQwenOAuthWorkerPostResult>;

	/**
	 * Makes a multipart/form-data POST request using a base64 file payload.
	 * Useful for endpoints like /audio/transcriptions when running in qwen-oauth mode.
	 */
	postMultipartBase64?(options: IQwenOAuthWorkerPostMultipartBase64Options): Promise<IQwenOAuthWorkerPostResult>;

	/**
	 * Makes a streaming POST request.
	 */
	onDynamicStream(options: IQwenOAuthWorkerPostOptions): Event<IQwenOAuthWorkerStreamChunk>;
}

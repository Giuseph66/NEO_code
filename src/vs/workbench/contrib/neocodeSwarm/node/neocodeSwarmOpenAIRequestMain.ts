/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { getErrorMessage } from '../../../../base/common/errors.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Server as ChildProcessServer } from '../../../../base/parts/ipc/node/ipc.cp.js';
import { Server as UtilityProcessServer } from '../../../../base/parts/ipc/node/ipc.mp.js';
import { isUtilityProcess } from '../../../../base/parts/sandbox/node/electronTypes.js';
import { asText } from '../../../../platform/request/common/request.js';
import { nodeRequest } from '../../../../platform/request/node/requestService.js';
import { getProxyAgent } from '../../../../platform/request/node/proxy.js';
import {
	IOpenAIHttpRequestOptions,
	IOpenAIHttpResponse,
	IOpenAIRequestService,
	NEO_SWARM_OPENAI_REQUEST_CHANNEL
} from '../common/neocodeSwarmOpenAIRequestTypes.js';

class OpenAIRequestService extends Disposable implements IOpenAIRequestService {
	private static readonly defaultUserAgent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

	private static readonly transientErrorCodes = new Set([
		'ECONNRESET',
		'ECONNREFUSED',
		'EPIPE',
		'ETIMEDOUT',
		'ESOCKETTIMEDOUT',
		'ENETUNREACH',
		'EHOSTUNREACH',
		'ENOTFOUND',
		'EAI_AGAIN',
		'ECONNABORTED',
		'UND_ERR_CONNECT_TIMEOUT',
		'UND_ERR_HEADERS_TIMEOUT',
		'UND_ERR_BODY_TIMEOUT',
		'UND_ERR_SOCKET',
		'UND_ERR_ABORTED',
		'ERR_NETWORK'
	]);

	async request(options: IOpenAIHttpRequestOptions): Promise<IOpenAIHttpResponse> {
		const timeoutMs = Math.max(1000, options.timeoutMs ?? 45000);
		let lastError: unknown;
		const maxAttempts = 5;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return await this.requestWithNodeRequest(options, timeoutMs);
			} catch (error) {
				lastError = error;
				if (!this.shouldRetry(error) || attempt >= maxAttempts) {
					break;
				}
				const delayMs = Math.min(300 * (2 ** (attempt - 1)), 2500);
				await new Promise(resolve => setTimeout(resolve, delayMs));
			}
		}
		throw this.createRequestError(options, lastError);
	}

	private async requestWithNodeRequest(options: IOpenAIHttpRequestOptions, timeoutMs: number): Promise<IOpenAIHttpResponse> {
		const agent = await getProxyAgent(options.url, process.env, {});
		const requestHeaders = this.withDefaultHeaders(options.headers);
		const context = await nodeRequest({
			url: options.url,
			type: options.method,
			headers: requestHeaders,
			data: options.body,
			timeout: timeoutMs,
			agent
		}, CancellationToken.None);
		const body = (await asText(context)) ?? '';
		const responseHeaders: Record<string, string> = {};
		for (const [key, value] of Object.entries(context.res.headers)) {
			if (typeof value === 'string') {
				responseHeaders[key] = value;
			} else if (Array.isArray(value)) {
				responseHeaders[key] = value.join(', ');
			}
		}
		return {
			statusCode: context.res.statusCode ?? 0,
			body,
			headers: responseHeaders
		};
	}

	private withDefaultHeaders(input?: Record<string, string>): Record<string, string> {
		const headers = { ...(input ?? {}) };
		const hasUserAgent = Object.keys(headers).some(key => key.toLowerCase() === 'user-agent');
		const hasAccept = Object.keys(headers).some(key => key.toLowerCase() === 'accept');
		const hasAcceptLanguage = Object.keys(headers).some(key => key.toLowerCase() === 'accept-language');
		if (!hasUserAgent) {
			// chatgpt.com Codex endpoint may reset Node requests that omit User-Agent.
			headers['User-Agent'] = OpenAIRequestService.defaultUserAgent;
		}
		if (!hasAccept) {
			headers['Accept'] = 'application/json, text/event-stream, */*';
		}
		if (!hasAcceptLanguage) {
			headers['Accept-Language'] = 'en-US,en;q=0.9';
		}
		return headers;
	}

	private shouldRetry(error: unknown): boolean {
		if (error instanceof Error && error.name === 'AbortError') {
			return false;
		}

		for (const candidate of this.collectErrorChain(error)) {
			const code = candidate.code?.trim().toUpperCase();
			if (code && OpenAIRequestService.transientErrorCodes.has(code)) {
				return true;
			}
			const message = getErrorMessage(candidate).trim().toLowerCase();
			if (message === 'fetch failed' || message.includes('socket hang up') || message.includes('connection reset by peer')) {
				return true;
			}
		}

		return false;
	}

	private collectErrorChain(error: unknown): Array<NodeJS.ErrnoException> {
		const result: Array<NodeJS.ErrnoException> = [];
		const seen = new Set<unknown>();
		let cursor: unknown = error;
		while (cursor && !seen.has(cursor)) {
			seen.add(cursor);
			if (typeof cursor === 'object' && cursor !== null) {
				result.push(cursor as NodeJS.ErrnoException);
				const nextCause = this.getCause(cursor);
				if (nextCause !== undefined) {
					cursor = nextCause;
					continue;
				}
			}
			break;
		}
		return result;
	}

	private createRequestError(options: IOpenAIHttpRequestOptions, error: unknown): Error {
		const detail = this.describeErrorChain(error);
		const endpoint = this.sanitizeUrl(options.url);
		const message = `OpenAI request failed (${options.method} ${endpoint}). ${detail}.`;
		return new Error(message);
	}

	private sanitizeUrl(rawUrl: string): string {
		try {
			const parsed = new URL(rawUrl);
			return `${parsed.origin}${parsed.pathname}`;
		} catch {
			return rawUrl;
		}
	}

	private describeErrorChain(error: unknown): string {
		const chain: string[] = [];
		const seen = new Set<unknown>();
		let cursor: unknown = error;
		while (cursor && !seen.has(cursor)) {
			seen.add(cursor);
			chain.push(this.describeError(cursor));
			if (typeof cursor !== 'object' || cursor === null) {
				break;
			}
			const nextCause = this.getCause(cursor);
			if (nextCause === undefined) {
				break;
			}
			cursor = nextCause;
		}
		return chain.join(' <- ');
	}

	private getCause(value: object): unknown {
		return (value as { cause?: unknown }).cause;
	}

	private describeError(error: unknown): string {
		if (!error || typeof error !== 'object') {
			return String(error);
		}

		const value = error as NodeJS.ErrnoException & { address?: string; port?: number; cause?: unknown };
		const message = getErrorMessage(value);
		const details: string[] = [];
		if (value.code) {
			details.push(`code=${value.code}`);
		}
		if (value.errno !== undefined) {
			details.push(`errno=${value.errno}`);
		}
		if (value.syscall) {
			details.push(`syscall=${value.syscall}`);
		}
		if (value.address) {
			details.push(`address=${value.address}`);
		}
		if (value.port !== undefined) {
			details.push(`port=${value.port}`);
		}
		return details.length ? `${message} (${details.join(', ')})` : message;
	}
}

let ipcServer: ChildProcessServer<string> | UtilityProcessServer;
if (isUtilityProcess(process)) {
	ipcServer = new UtilityProcessServer();
} else {
	ipcServer = new ChildProcessServer(NEO_SWARM_OPENAI_REQUEST_CHANNEL);
}

const service = new OpenAIRequestService();
const disposables = new DisposableStore();
ipcServer.registerChannel(NEO_SWARM_OPENAI_REQUEST_CHANNEL, ProxyChannel.fromService(service, disposables));

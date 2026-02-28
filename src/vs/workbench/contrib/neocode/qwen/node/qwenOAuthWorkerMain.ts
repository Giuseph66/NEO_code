/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { ProxyChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { Server as ChildProcessServer } from '../../../../../base/parts/ipc/node/ipc.cp.js';
import { Server as UtilityProcessServer } from '../../../../../base/parts/ipc/node/ipc.mp.js';
import { isUtilityProcess } from '../../../../../base/parts/sandbox/node/electronTypes.js';
import {
	IQwenOAuthWorkerPostOptions,
	IQwenOAuthWorkerPostResult,
	IQwenOAuthWorkerService,
	IQwenOAuthWorkerStreamChunk,
	NEO_QWEN_OAUTH_WORKER_CHANNEL
} from '../common/qwenOAuthWorkerTypes.js';

/**
 * Node.js utility process worker that makes HTTP requests on behalf of
 * the browser renderer, bypassing CORS restrictions.
 */
class QwenOAuthWorkerService extends Disposable implements IQwenOAuthWorkerService {

	async post(options: IQwenOAuthWorkerPostOptions): Promise<IQwenOAuthWorkerPostResult> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/x-www-form-urlencoded',
			'Accept': 'application/json',
			...options.headers,
		};

		const response = await fetch(options.url, {
			method: 'POST',
			headers,
			body: options.body,
		});

		const body = await response.text();
		return {
			statusCode: response.status,
			body,
		};
	}

	onDynamicStream(options: IQwenOAuthWorkerPostOptions): Event<IQwenOAuthWorkerStreamChunk> {
		const emitter = new Emitter<IQwenOAuthWorkerStreamChunk>();

		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			'Accept': 'text/event-stream',
			...options.headers,
		};

		fetch(options.url, {
			method: 'POST',
			headers,
			body: options.body,
		}).then(async response => {
			if (!response.ok) {
				const errorTxt = await response.text();
				emitter.fire({ type: 'error', error: `HTTP ${response.status}: ${errorTxt}` });
				emitter.dispose();
				return;
			}

			if (!response.body) {
				emitter.fire({ type: 'done' });
				emitter.dispose();
				return;
			}

			const reader = response.body.getReader();
			const decoder = new TextDecoder();

			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				emitter.fire({ type: 'data', data: decoder.decode(value, { stream: true }) });
			}

			emitter.fire({ type: 'done' });
			emitter.dispose();
		}).catch(error => {
			emitter.fire({ type: 'error', error: String(error) });
			emitter.dispose();
		});

		return emitter.event;
	}
}

// ─── IPC Bootstrap ───────────────────────────────────────────────────────────

let ipcServer: ChildProcessServer<string> | UtilityProcessServer;
if (isUtilityProcess(process)) {
	ipcServer = new UtilityProcessServer();
} else {
	ipcServer = new ChildProcessServer(NEO_QWEN_OAUTH_WORKER_CHANNEL);
}

const service = new QwenOAuthWorkerService();
const disposables = new DisposableStore();
ipcServer.registerChannel(NEO_QWEN_OAUTH_WORKER_CHANNEL, ProxyChannel.fromService(service, disposables));

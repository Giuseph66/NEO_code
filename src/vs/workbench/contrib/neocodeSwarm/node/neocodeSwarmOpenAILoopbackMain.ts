/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as http from 'http';
import { DeferredPromise } from '../../../../base/common/async.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Server as ChildProcessServer } from '../../../../base/parts/ipc/node/ipc.cp.js';
import { Server as UtilityProcessServer } from '../../../../base/parts/ipc/node/ipc.mp.js';
import { isUtilityProcess } from '../../../../base/parts/sandbox/node/electronTypes.js';
import { IOpenAILoopbackCallbackServerService, IOpenAILoopbackResult, IOpenAILoopbackStartOptions, NEO_SWARM_OPENAI_LOOPBACK_CHANNEL } from '../common/neocodeSwarmOpenAILoopbackTypes.js';

const SUCCESS_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NeoCode • Login concluido</title>
<style>
	:root { color-scheme: light dark; }
	* { box-sizing: border-box; }
	body {
		margin: 0;
		min-height: 100vh;
		display: grid;
		place-items: center;
		font-family: "Segoe UI", ui-sans-serif, system-ui, -apple-system, sans-serif;
		background: radial-gradient(circle at top, #1f2a5e 0%, #0f1020 45%, #090a12 100%);
		color: #eef2ff;
	}
	.card {
		width: min(680px, calc(100vw - 32px));
		border-radius: 16px;
		padding: 28px 26px;
		background: rgba(16, 19, 35, 0.9);
		border: 1px solid rgba(255, 255, 255, 0.16);
		box-shadow: 0 18px 60px rgba(0, 0, 0, 0.45);
	}
	h1 { margin: 0 0 10px; font-size: 24px; color: #90f7d4; }
	p { margin: 0; opacity: 0.92; line-height: 1.5; }
	.hint {
		margin-top: 14px;
		font-size: 13px;
		opacity: 0.75;
	}
</style>
</head>
<body>
	<section class="card">
		<h1>Login concluido com sucesso</h1>
		<p>Sua conta foi autenticada. Pode fechar esta aba e voltar para o NeoCode.</p>
		<p class="hint">Se a janela do editor estiver aberta, o processo continua automaticamente.</p>
	</section>
</body>
</html>`;

class OpenAILoopbackCallbackServer extends Disposable implements IOpenAILoopbackCallbackServerService {
	private server: http.Server | undefined;
	private resultPromise: DeferredPromise<IOpenAILoopbackResult> | undefined;
	private timeoutHandle: ReturnType<typeof setTimeout> | undefined;

	async start(options: IOpenAILoopbackStartOptions): Promise<void> {
		await this.stop();

		const httpModule = await import('http');
		this.resultPromise = new DeferredPromise<IOpenAILoopbackResult>();
		let settled = false;

		this.server = httpModule.createServer((req, res) => {
			const base = `http://${options.host}:${options.port}`;
			const reqUrl = new URL(req.url || '/', base);
			if (reqUrl.pathname !== options.path) {
				res.writeHead(404);
				res.end('Not found');
				return;
			}

			const error = reqUrl.searchParams.get('error');
			const errorDescription = reqUrl.searchParams.get('error_description');
			const code = reqUrl.searchParams.get('code');
			const state = reqUrl.searchParams.get('state');

			if (state && !this.stateMatchesNonce(state, options.expectedState)) {
				res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
				res.end(this.getErrorHtml('State invalido. Reinicie o login.'));
				if (!settled) {
					settled = true;
					this.resultPromise?.complete({ kind: 'error', error: 'State invalido.', query: reqUrl.searchParams.toString() });
				}
				void this.stop();
				return;
			}

			if (error) {
				res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
				res.end(this.getErrorHtml(errorDescription || error));
				if (!settled) {
					settled = true;
					this.resultPromise?.complete({ kind: 'error', error: errorDescription || error, query: reqUrl.searchParams.toString() });
				}
				void this.stop();
				return;
			}

			if (!code || !state) {
				res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
				res.end(this.getErrorHtml('Parametros code/state ausentes.'));
				return;
			}

			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
			res.end(SUCCESS_HTML);

			if (!settled) {
				settled = true;
				this.resultPromise?.complete({ kind: 'success', query: reqUrl.searchParams.toString() });
			}

			void this.stop();
		});

		this.server.on('error', (err) => {
			if (!settled) {
				settled = true;
				this.resultPromise?.complete({ kind: 'error', error: err.message });
			}
			void this.stop();
		});

		await new Promise<void>((resolve, reject) => {
			const onError = (err: Error) => {
				this.server?.off('listening', onListening);
				reject(err);
			};
			const onListening = () => {
				this.server?.off('error', onError);
				resolve();
			};
			this.server?.once('error', onError);
			this.server?.once('listening', onListening);
			this.server?.listen(options.port, options.host);
		});

		this.timeoutHandle = setTimeout(() => {
			if (!settled) {
				settled = true;
				this.resultPromise?.complete({ kind: 'timeout' });
			}
			void this.stop();
		}, Math.max(1, options.timeoutMs));
	}

	waitForResult(): Promise<IOpenAILoopbackResult> {
		if (!this.resultPromise) {
			return Promise.resolve({ kind: 'error', error: 'Loopback server not started.' });
		}
		return this.resultPromise.p;
	}

	async stop(): Promise<void> {
		if (this.timeoutHandle) {
			clearTimeout(this.timeoutHandle);
			this.timeoutHandle = undefined;
		}

		const server = this.server;
		this.server = undefined;

		if (!server) {
			return;
		}

		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
	}

	private stateMatchesNonce(receivedState: string, nonce: string): boolean {
		const trimmed = receivedState.trim();
		if (!trimmed) {
			return false;
		}
		if (trimmed === nonce) {
			return true;
		}
		if (trimmed.includes(`nonce=${encodeURIComponent(nonce)}`) || trimmed.includes(`nonce=${nonce}`)) {
			return true;
		}
		try {
			const parsed = new URL(trimmed);
			return parsed.searchParams.get('nonce') === nonce;
		} catch {
			return false;
		}
	}

	private getErrorHtml(message: string): string {
		const escaped = this.escapeHtml(message || 'Erro no login.');
		return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NeoCode • Erro no login</title>
<style>
	:root { color-scheme: light dark; }
	body {
		margin: 0;
		min-height: 100vh;
		display: grid;
		place-items: center;
		font-family: "Segoe UI", ui-sans-serif, system-ui, -apple-system, sans-serif;
		background: radial-gradient(circle at top, #3c1224 0%, #140910 44%, #0a0709 100%);
		color: #ffe5ea;
	}
	.card {
		width: min(680px, calc(100vw - 32px));
		border-radius: 16px;
		padding: 26px;
		background: rgba(31, 12, 20, 0.9);
		border: 1px solid rgba(255, 140, 150, 0.35);
	}
	h1 { margin: 0 0 10px; font-size: 23px; color: #ff9cad; }
	p { margin: 0; line-height: 1.5; }
</style>
</head>
<body>
	<section class="card">
		<h1>Nao foi possivel concluir o login</h1>
		<p>${escaped}</p>
	</section>
</body>
</html>`;
	}

	private escapeHtml(value: string): string {
		return value
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}
}

let ipcServer: ChildProcessServer<string> | UtilityProcessServer;
if (isUtilityProcess(process)) {
	ipcServer = new UtilityProcessServer();
} else {
	ipcServer = new ChildProcessServer(NEO_SWARM_OPENAI_LOOPBACK_CHANNEL);
}

const service = new OpenAILoopbackCallbackServer();
const disposables = new DisposableStore();
ipcServer.registerChannel(NEO_SWARM_OPENAI_LOOPBACK_CHANNEL, ProxyChannel.fromService(service, disposables));

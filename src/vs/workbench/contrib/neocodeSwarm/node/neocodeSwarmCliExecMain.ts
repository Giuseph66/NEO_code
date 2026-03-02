/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Server as ChildProcessServer } from '../../../../base/parts/ipc/node/ipc.cp.js';
import { Server as UtilityProcessServer } from '../../../../base/parts/ipc/node/ipc.mp.js';
import { isUtilityProcess } from '../../../../base/parts/sandbox/node/electronTypes.js';
import { spawn } from 'child_process';
import {
	INeocodeSwarmCliExecOptions,
	INeocodeSwarmCliExecResult,
	INeocodeSwarmCliExecService,
	NEO_SWARM_CLI_EXEC_CHANNEL
} from '../common/neocodeSwarmCliExecTypes.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

class NeocodeSwarmCliExecService extends Disposable implements INeocodeSwarmCliExecService {
	async exec(options: INeocodeSwarmCliExecOptions): Promise<INeocodeSwarmCliExecResult> {
		const timeoutMs = Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		return new Promise<INeocodeSwarmCliExecResult>((resolve, reject) => {
			let stdout = '';
			let stderr = '';
			let timedOut = false;
			let resolved = false;

			// Enrich PATH so npm-global and user-local binaries (e.g. 'claude') are found
			// inside the Electron utility process, which often has a stripped environment.
			const home = process.env['HOME'] ?? '';
			const pathParts = [
				process.env['PATH'] ?? '',
				'/usr/local/bin',
				'/usr/bin',
				'/bin',
				home ? `${home}/.local/bin` : '',
				home ? `${home}/bin` : '',
				home ? `${home}/.npm-global/bin` : '',
				home ? `${home}/.npm/bin` : '',
				'/opt/homebrew/bin',
				'/snap/bin',
			].filter(p => p.trim() !== '');
			const enrichedEnv: Record<string, string | undefined> = {
				...process.env,
				PATH: pathParts.join(':'),
				TERM: 'dumb',
				NO_COLOR: '1',
				// Caller-supplied env vars override everything above (e.g. OPENAI_API_KEY for codex exec).
				...(options.env ?? {}),
			};

			const child = spawn(options.command, options.args, {
				cwd: options.cwd || process.cwd(),
				env: enrichedEnv,
				stdio: ['pipe', 'pipe', 'pipe'],
			});

			const settle = (result: INeocodeSwarmCliExecResult): void => {
				if (resolved) {
					return;
				}
				resolved = true;
				resolve(result);
			};

			const fail = (error: unknown): void => {
				if (resolved) {
					return;
				}
				resolved = true;
				reject(error);
			};

			const timer = setTimeout(() => {
				timedOut = true;
				try {
					child.kill('SIGTERM');
				} catch {
					// ignore
				}
				setTimeout(() => {
					try {
						child.kill('SIGKILL');
					} catch {
						// ignore
					}
				}, 2_000);
			}, timeoutMs);

			const appendOutput = (target: 'stdout' | 'stderr', chunk: string): void => {
				if (!chunk) {
					return;
				}
				if (target === 'stdout') {
					stdout = `${stdout}${chunk}`.slice(-MAX_OUTPUT_BYTES);
				} else {
					stderr = `${stderr}${chunk}`.slice(-MAX_OUTPUT_BYTES);
				}
			};

			child.stdout?.setEncoding('utf8');
			child.stderr?.setEncoding('utf8');
			child.stdout?.on('data', data => appendOutput('stdout', String(data)));
			child.stderr?.on('data', data => appendOutput('stderr', String(data)));

			child.on('error', error => {
				clearTimeout(timer);
				fail(error);
			});

			child.on('close', (code, signal) => {
				clearTimeout(timer);
				const normalizedCode = typeof code === 'number' ? code : (signal ? 128 : 1);
				settle({
					exitCode: normalizedCode,
					stdout,
					stderr,
					timedOut
				});
			});

			if (typeof options.stdin === 'string' && options.stdin.length > 0) {
				try {
					child.stdin?.write(options.stdin);
				} catch {
					// ignore write failures
				}
			}
			try {
				child.stdin?.end();
			} catch {
				// ignore end failures
			}
		});
	}
}

let ipcServer: ChildProcessServer<string> | UtilityProcessServer;
if (isUtilityProcess(process)) {
	ipcServer = new UtilityProcessServer();
} else {
	ipcServer = new ChildProcessServer(NEO_SWARM_CLI_EXEC_CHANNEL);
}

const service = new NeocodeSwarmCliExecService();
const disposables = new DisposableStore();
ipcServer.registerChannel(NEO_SWARM_CLI_EXEC_CHANNEL, ProxyChannel.fromService(service, disposables));

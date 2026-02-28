/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IQwenAuthService } from '../../neocode/qwen/common/qwenTypes.js';
import { QwenRuntimeAdapter, IQwenSdkTaskOptions } from '../../neocode/qwen/browser/qwenRuntimeAdapter.js';
import { INeocodeSwarmProviderConfig } from '../common/neocodeSwarmTypes.js';

export interface IQwenCodeTaskOptions {
	prompt: string;
	cwd?: string;
	files?: string[];
	diff?: string;
	mode?: 'plan' | 'default' | 'auto-edit' | 'yolo';
}

export interface IQwenCodeEvent {
	type: 'system' | 'session_start' | 'assistant' | 'result';
	content?: string;
	final?: boolean;
	success?: boolean;
	duration?: number;
	error?: string;
}

export class QwenCodeAgentRunner extends Disposable {
	private readonly _onEvent = new Emitter<IQwenCodeEvent>();
	readonly onEvent: Event<IQwenCodeEvent> = this._onEvent.event;

	private adapter: QwenRuntimeAdapter | undefined;

	constructor(
		@ILogService private readonly logService: ILogService,
		@IQwenAuthService private readonly qwenAuthService: IQwenAuthService,
		@IInstantiationService private readonly instantiationService: IInstantiationService
	) {
		super();
		this._register(this._onEvent);
	}

	async runTask(config: INeocodeSwarmProviderConfig, options: IQwenCodeTaskOptions, _secret: string | undefined, token: CancellationToken): Promise<void> {
		const startTime = Date.now();
		this._onEvent.fire({ type: 'session_start' });

		try {
			if (token.isCancellationRequested) {
				this._onEvent.fire({ type: 'system', content: 'Tarefa cancelada.' });
				this._onEvent.fire({ type: 'result', success: false, error: 'cancelled', duration: Date.now() - startTime });
				return;
			}

			// Try SDK first, fall back to CLI
			await this.runViaSdk(config, options, _secret, token);

			this._onEvent.fire({ type: 'result', success: true, duration: Date.now() - startTime });

		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : 'Unknown error';

			if (message === 'cancelled') {
				this._onEvent.fire({ type: 'system', content: 'Tarefa cancelada.' });
				this._onEvent.fire({ type: 'result', success: false, error: 'cancelled', duration: Date.now() - startTime });
				return;
			}

			this.logService.error('[neocode swarm] QwenCode task failed:', error);
			this._onEvent.fire({ type: 'result', success: false, error: message, duration: Date.now() - startTime });
		}
	}

	/** Try to run the task via the in-process Qwen SDK. Throws if unavailable. */
	private async runViaSdk(config: INeocodeSwarmProviderConfig, options: IQwenCodeTaskOptions, _secret: string | undefined, token: CancellationToken): Promise<void> {
		const envData = await this.qwenAuthService.buildRuntimeEnv();
		const qwenConfig = this.qwenAuthService.loadConfig();

		if (_secret && config.authMethod === 'apiKey' && qwenConfig.envVarName) {
			envData.env[qwenConfig.envVarName] = _secret;
		}

		// Ensure cwd is passed properly
		const runtimeEnv = {
			...envData,
			cwd: options.cwd || '.',
		};

		const effectiveConfig = {
			...qwenConfig,
			modelId: config.selectedModel ?? qwenConfig.modelId,
			...(config.baseUrl ? { baseUrl: config.baseUrl } : {})
		};

		const permissionMode = this.resolvePermissionMode(options.mode);
		const { controller: abortController, disposables: abortDisposables } = this.buildAbortController(token);

		const sdkOptions: IQwenSdkTaskOptions = {
			prompt: options.prompt,
			permissionMode,
			includePartialMessages: true,
			excludeTools: permissionMode === 'plan' ? ['write', 'edit'] : undefined,
			abortController
		};

		if (!this.adapter) {
			this.adapter = this._register(this.instantiationService.createInstance(QwenRuntimeAdapter));
		}

		try {
			const stream = this.adapter.runTask(effectiveConfig, runtimeEnv as any, sdkOptions, token);
			let responseText = '';

			for await (const chunk of stream) {
				if (token.isCancellationRequested) {
					break;
				}

				if (chunk.type === 'content' && chunk.value) {
					responseText += chunk.value;
					this._onEvent.fire({ type: 'assistant', content: chunk.value });
				} else if (chunk.type === 'tool_call' && chunk.toolName) {
					this._onEvent.fire({ type: 'system', content: `Executando: ${chunk.toolName}` });
				} else if (chunk.type === 'error' && chunk.error) {
					this._onEvent.fire({ type: 'system', content: `Erro: ${chunk.error}` });
				}
				// 'done' chunks are silently consumed
			}

			if (responseText.trim().length === 0) {
				this._onEvent.fire({ type: 'assistant', content: 'Qwen concluiu sem texto.', final: true });
			} else {
				this._onEvent.fire({ type: 'assistant', final: true });
			}

		} finally {
			abortDisposables.dispose();
		}
	}


	private resolvePermissionMode(mode: IQwenCodeTaskOptions['mode']): IQwenSdkTaskOptions['permissionMode'] {
		switch (mode) {
			case 'yolo': return 'bypassPermissions';
			case 'auto-edit': return 'acceptEdits';
			case 'default': return 'default';
			case 'plan':
			default: return 'plan';
		}
	}

	private buildAbortController(token: CancellationToken): { controller: AbortController; disposables: DisposableStore } {
		const controller = new AbortController();
		const disposables = new DisposableStore();
		disposables.add(token.onCancellationRequested(() => controller.abort()));
		return { controller, disposables };
	}
}

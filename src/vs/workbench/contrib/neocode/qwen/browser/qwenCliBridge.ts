/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { disposableTimeout, RunOnceScheduler } from '../../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ICommandDetectionCapability, TerminalCapability } from '../../../../../platform/terminal/common/capabilities/capabilities.js';
import { TerminalLocation } from '../../../../../platform/terminal/common/terminal.js';
import { ITerminalGroupService, ITerminalInstance, ITerminalService } from '../../../../contrib/terminal/browser/terminal.js';
import { IQwenCliInfo } from '../common/qwenTypes.js';

const CLI_CONSENT_KEY = 'neocode.qwen.cliConsent';
const SHELL_INTEGRATION_TIMEOUT = 5000;
const NO_SHELL_INTEGRATION_IDLE = 800;

export class QwenCliBridge extends Disposable {
	constructor(
		@ITerminalService private readonly terminalService: ITerminalService,
		@ITerminalGroupService private readonly terminalGroupService: ITerminalGroupService,
		@IDialogService private readonly dialogService: IDialogService,
		@IStorageService private readonly storageService: IStorageService
	) {
		super();
	}

	async detectQwenCli(pathOverride?: string): Promise<IQwenCliInfo> {
		if (pathOverride?.trim()) {
			const version = await this.getVersion(pathOverride.trim());
			return { path: pathOverride.trim(), source: 'manual', ok: version.ok, version: version.version, output: version.output };
		}
		const envPath = typeof process !== 'undefined' ? process.env.QWEN_CODE_CLI_PATH : undefined;
		if (envPath?.trim()) {
			const version = await this.getVersion(envPath.trim());
			return { path: envPath.trim(), source: 'env', ok: version.ok, version: version.version, output: version.output };
		}
		const version = await this.getVersion('qwen');
		return { path: 'qwen', source: version.ok ? 'auto' : 'none', ok: version.ok, version: version.version, output: version.output };
	}

	async getVersion(cliPath: string): Promise<{ ok: boolean; version?: string; output: string }> {
		if (!await this.ensureConsent()) {
			return { ok: false, output: localize('neocode.qwen.cli.cancelled', 'Execucao cancelada pelo usuario.') };
		}
		const terminal = await this.createFeatureTerminal('Qwen CLI', true);
		const output = await this.getTerminalOutput(terminal, `${quote(cliPath)} --version`, 12000);
		const line = output.split('\n').map(l => l.trim()).find(Boolean);
		return { ok: !!line && !/not found|nao encontrado|command not found/i.test(output), version: line, output };
	}

	async validateCli(cliPath: string): Promise<{ ok: boolean; output: string }> {
		if (!await this.ensureConsent()) {
			return { ok: false, output: localize('neocode.qwen.cli.cancelled', 'Execucao cancelada pelo usuario.') };
		}
		const terminal = await this.createFeatureTerminal('Qwen CLI Validate', true);
		const output = await this.getTerminalOutput(terminal, `${quote(cliPath)} --help`, 12000);
		return { ok: !/not found|nao encontrado|command not found/i.test(output), output };
	}

	async startOAuthFlowInTerminal(cliPath: string): Promise<void> {
		if (!await this.ensureConsent()) {
			return;
		}
		// Create a regular interactive terminal and launch the Qwen CLI TUI.
		// After the TUI initializes (~3s), we programmatically send "/auth"
		// via sendText() which writes directly to the PTY, bypassing any
		// VS Code keybinding interception of the "/" character.
		const terminal = this._register(await this.terminalService.createTerminal({
			config: {
				name: 'Qwen OAuth Login',
				isTransient: false,
				isFeatureTerminal: false,
				forceShellIntegration: true,
				useShellEnvironment: true
			},
			location: TerminalLocation.Panel,
		}));
		this.terminalService.setActiveInstance(terminal);
		this.terminalGroupService.showPanel(false);
		terminal.runCommand(`${quote(cliPath)}`, true);
		// Wait for TUI to fully initialize, then send /auth via PTY
		setTimeout(() => {
			void terminal.sendText('/auth', true);
		}, 3000);
	}

	private async ensureConsent(): Promise<boolean> {
		const alreadyConsented = this.storageService.getBoolean(CLI_CONSENT_KEY, StorageScope.PROFILE, false) ?? false;
		if (alreadyConsented) {
			return true;
		}
		const confirmation = await this.dialogService.confirm({
			type: 'warning',
			message: localize('neocode.qwen.cli.consent.title', 'Permitir que o NeoCode execute o Qwen CLI local?'),
			detail: localize('neocode.qwen.cli.consent.detail', 'O CLI pode acessar arquivos e variaveis de ambiente. Revise permissoes antes de continuar.'),
			primaryButton: localize('neocode.qwen.cli.consent.allow', 'Permitir')
		});
		if (!confirmation.confirmed) {
			return false;
		}
		this.storageService.store(CLI_CONSENT_KEY, true, StorageScope.PROFILE, StorageTarget.USER);
		return true;
	}

	private async createFeatureTerminal(name: string, useLoginShell: boolean): Promise<ITerminalInstance> {
		const terminal = this._register(await this.terminalService.createTerminal({
			config: {
				name,
				isTransient: true,
				isFeatureTerminal: true,
				forceShellIntegration: true,
				useShellEnvironment: useLoginShell
			},
			location: TerminalLocation.Panel,
		}));
		this.terminalService.setActiveInstance(terminal);
		this.terminalGroupService.showPanel(false);
		return terminal;
	}

	private async getTerminalOutput(terminal: ITerminalInstance, command: string, timeoutMs: number): Promise<string> {
		const shellIntegration = terminal.capabilities.get(TerminalCapability.CommandDetection);
		if (shellIntegration) {
			return this.getTerminalOutputInner(terminal, command, shellIntegration, timeoutMs);
		}
		const store = new DisposableStore();
		return new Promise<string>(resolve => {
			store.add(terminal.capabilities.onDidAddCapability(e => {
				if (e.id === TerminalCapability.CommandDetection) {
					store.dispose();
					void this.getTerminalOutputInner(terminal, command, e.capability, timeoutMs).then(resolve);
				}
			}));
			store.add(disposableTimeout(() => {
				store.dispose();
				void this.getTerminalOutputInner(terminal, command, undefined, timeoutMs).then(resolve);
			}, SHELL_INTEGRATION_TIMEOUT));
		});
	}

	private async getTerminalOutputInner(terminal: ITerminalInstance, command: string, shellIntegration: ICommandDetectionCapability | undefined, timeoutMs: number): Promise<string> {
		const cts = new CancellationTokenSource();
		const store = new DisposableStore();
		return new Promise<string>(resolve => {
			let allData = '';
			store.add(terminal.onLineData(line => allData += `${line}\n`));
			if (shellIntegration) {
				store.add(shellIntegration.onCommandFinished(e => resolve(e.getOutput() || allData)));
			} else {
				const done = store.add(new RunOnceScheduler(() => resolve(allData), NO_SHELL_INTEGRATION_IDLE));
				store.add(terminal.onData(() => done.schedule()));
			}
			store.add(cts.token.onCancellationRequested(() => resolve(allData)));
			store.add(disposableTimeout(() => cts.cancel(), timeoutMs));
			terminal.runCommand(command, true);
		}).finally(() => {
			store.dispose();
			cts.dispose(true);
		});
	}
}

function quote(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) {
		return "''";
	}
	if (/^[a-zA-Z0-9_./:-]+$/.test(trimmed)) {
		return trimmed;
	}
	return `'${trimmed.replace(/'/g, `"'"'`)}'`;
}

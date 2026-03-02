/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { createStyleSheet } from '../../../../base/browser/domStylesheets.js';
import { URI } from '../../../../base/common/uri.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { localize } from '../../../../nls.js';
import { INeocodeSwarmActivityService } from './neocodeSwarmActivityService.js';
import {
	ISwarmActivitySession,
	ISwarmAgentState,
	SwarmAgentStatus,
	ISwarmAgentLogEntry,
} from '../common/neocodeSwarmTypes.js';

// ─── CSS injected once on first panel creation ────────────────────────────

const ACTIVITY_PANEL_STYLES = `
.neo-swarm-activity {
	height: 100%;
	display: flex;
	flex-direction: column;
	background: var(--vscode-editor-background);
	color: var(--vscode-editor-foreground);
	font-family: var(--vscode-font-family);
	font-size: var(--vscode-font-size);
	overflow: hidden;
}
.neo-swarm-header {
	display: flex;
	align-items: center;
	gap: 12px;
	padding: 12px 16px 10px;
	border-bottom: 1px solid var(--vscode-panel-border);
	flex-shrink: 0;
	background: var(--vscode-sideBar-background);
}
.neo-swarm-title {
	font-weight: 600;
	font-size: 13px;
	letter-spacing: 0.3px;
}
.neo-swarm-orchestrator-status {
	margin-left: auto;
	font-size: 11px;
	opacity: 0.85;
	padding: 2px 8px;
	background: var(--vscode-badge-background);
	color: var(--vscode-badge-foreground);
	border-radius: 10px;
}
.neo-swarm-orchestrator-status.complete {
	background: var(--vscode-terminal-ansiGreen);
	color: #000;
}
.neo-swarm-actions {
	display: flex;
	gap: 6px;
	margin-left: 12px;
}
.neo-swarm-action-btn {
	padding: 2px 8px;
	font-size: 11px;
	cursor: pointer;
	border: 1px solid var(--vscode-button-border);
	background: var(--vscode-button-secondaryBackground);
	color: var(--vscode-button-secondaryForeground);
	border-radius: 2px;
}
.neo-swarm-action-btn:hover {
	background: var(--vscode-button-secondaryHoverBackground);
}
.neo-swarm-action-btn:disabled {
	opacity: 0.5;
	cursor: default;
}
.neo-swarm-empty {
	flex: 1;
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	opacity: 0.5;
	gap: 8px;
	font-size: 13px;
}
.neo-swarm-empty-icon { font-size: 32px; }
.neo-swarm-agents {
	flex: 1;
	display: flex;
	gap: 1px;
	overflow: hidden;
	background: var(--vscode-panel-border);
}
.neo-swarm-agents.compact {
	flex-direction: column;
	background: var(--vscode-editor-background);
	overflow-y: auto;
	padding: 8px;
	gap: 8px;
}
.neo-agent-card {
	display: flex;
	flex-direction: column;
	overflow: hidden;
	background: var(--vscode-editor-background);
	min-width: 0;
}
.neo-swarm-agents:not(.compact) .neo-agent-card { flex: 1; }
.neo-swarm-agents.compact .neo-agent-card {
	border: 1px solid var(--vscode-panel-border);
	border-radius: 4px;
}
.neo-agent-card.status-working .neo-agent-header { border-left: 3px solid var(--vscode-terminal-ansiYellow); }
.neo-agent-card.status-done .neo-agent-header { border-left: 3px solid var(--vscode-terminal-ansiGreen); }
.neo-agent-card.status-error .neo-agent-header { border-left: 3px solid var(--vscode-terminal-ansiRed); }
.neo-agent-header {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 8px 10px;
	background: var(--vscode-sideBar-background);
	border-bottom: 1px solid var(--vscode-panel-border);
	flex-shrink: 0;
}
.neo-agent-emoji { font-size: 16px; }
.neo-agent-name { font-weight: 600; font-size: 12px; }
.neo-agent-role {
	font-size: 10px;
	opacity: 0.65;
	padding: 1px 5px;
	background: var(--vscode-badge-background);
	color: var(--vscode-badge-foreground);
	border-radius: 8px;
}
.neo-agent-status-badge { margin-left: auto; font-size: 11px; }
.neo-agent-task {
	font-size: 11px;
	padding: 6px 10px;
	opacity: 0.75;
	background: var(--vscode-textBlockQuote-background);
	border-bottom: 1px solid var(--vscode-panel-border);
	flex-shrink: 0;
	line-height: 1.4;
}
.neo-agent-log {
	flex: 1;
	overflow-y: auto;
	padding: 6px 0;
	display: flex;
	flex-direction: column;
	gap: 1px;
}
.neo-swarm-agents.compact .neo-agent-log { max-height: 100px; }
.neo-log-entry {
	padding: 2px 10px;
	font-size: 11px;
	line-height: 1.5;
	font-family: var(--vscode-editor-font-family);
	display: flex;
	align-items: flex-start;
	gap: 6px;
	word-break: break-word;
}
.neo-log-entry.thinking { opacity: 0.65; }
.neo-log-entry.tool { color: var(--vscode-terminal-ansiCyan); }
.neo-log-entry.error { color: var(--vscode-terminal-ansiRed); }
.neo-log-icon { flex-shrink: 0; }
.neo-swarm-timing {
	font-size: 11px;
	padding: 6px 16px;
	opacity: 0.55;
	border-top: 1px solid var(--vscode-panel-border);
	flex-shrink: 0;
}
`;

let stylesInjected = false;

function ensureStyles(): void {
	if (stylesInjected) { return; }
	stylesInjected = true;
	const styleEl = createStyleSheet();
	styleEl.textContent = ACTIVITY_PANEL_STYLES;
}

// ─── Editor Input ─────────────────────────────────────────────────────────

export class NeocodeSwarmActivityEditorInput extends EditorInput {
	static readonly ID = 'workbench.input.neocodeSwarmActivity';

	override get typeId(): string { return NeocodeSwarmActivityEditorInput.ID; }
	override get editorId(): string { return NeocodeSwarmActivityEditorInput.ID; }
	override getName(): string { return localize('neoSwarmActivityTitle', "NeoCode Swarm Activity"); }
	override getDescription(): string { return localize('neoSwarmActivityDesc', "Real-time swarm agent activity"); }
	override isDirty(): boolean { return false; }
	override readonly resource = URI.from({ scheme: 'neocode-swarm', path: 'activity' });
	override matches(other: EditorInput): boolean {
		return other instanceof NeocodeSwarmActivityEditorInput;
	}
}

// ─── Editor Pane ─────────────────────────────────────────────────────────

/**
 * Real-time swarm activity panel.
 * Wide (> 700 px): agents in columns. Narrow (≤ 700 px): stacked cards.
 */
export class NeocodeSwarmActivityEditorPane extends EditorPane {
	static readonly ID = 'workbench.editor.neocodeSwarmActivity';

	private container: HTMLElement | undefined;
	private agentsEl: HTMLElement | undefined;
	private orchestratorStatusEl: HTMLElement | undefined;
	private timingEl: HTMLElement | undefined;
	private copyMdBtn: HTMLButtonElement | undefined;
	private copyJsonBtn: HTMLButtonElement | undefined;
	private isCompact = true;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService _instantiationService: IInstantiationService,
		@INeocodeSwarmActivityService private readonly activityService: INeocodeSwarmActivityService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super(NeocodeSwarmActivityEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		ensureStyles();

		this.container = dom.append(parent, dom.$('.neo-swarm-activity'));

		// Header row
		const header = dom.append(this.container, dom.$('.neo-swarm-header'));
		dom.append(header, dom.$('span.neo-swarm-title', undefined, '🤖 NeoCode Swarm Activity'));
		this.orchestratorStatusEl = dom.append(header, dom.$('span.neo-swarm-orchestrator-status'));
		this.orchestratorStatusEl.textContent = '— Aguardando tarefa';

		const actions = dom.append(header, dom.$('.neo-swarm-actions'));
		this.copyMdBtn = dom.append(actions, dom.$('button.neo-swarm-action-btn', undefined, 'Copy MD')) as HTMLButtonElement;
		this.copyJsonBtn = dom.append(actions, dom.$('button.neo-swarm-action-btn', undefined, 'Copy JSON')) as HTMLButtonElement;

		this._register(dom.addDisposableListener(this.copyMdBtn, dom.EventType.CLICK, () => {
			const session = this.activityService.getCurrentSession();
			if (session) { this.copyAsMarkdown(session); }
		}));

		this._register(dom.addDisposableListener(this.copyJsonBtn, dom.EventType.CLICK, () => {
			const session = this.activityService.getCurrentSession();
			if (session) { this.copyAsJson(session); }
		}));

		// Agent area
		this.agentsEl = dom.append(this.container, dom.$('.neo-swarm-agents'));

		// Timing footer
		this.timingEl = dom.append(this.container, dom.$('.neo-swarm-timing'));
		this.timingEl.style.display = 'none';

		// Subscribe to live updates
		this._register(this.activityService.onDidChange(session => this.renderSession(session)));

		this.renderSession(this.activityService.getCurrentSession());
	}

	override layout(dimension: Dimension): void {
		if (!this.agentsEl) { return; }
		const compact = dimension.width <= 700;
		if (compact !== this.isCompact) {
			this.isCompact = compact;
			this.agentsEl.classList.toggle('compact', compact);
		}
	}

	// ─── Rendering ──────────────────────────────────────────────────────────

	private renderSession(session: ISwarmActivitySession | undefined): void {
		if (!this.container || !this.agentsEl || !this.orchestratorStatusEl || !this.timingEl) { return; }

		// Orchestrator status pill
		this.orchestratorStatusEl.textContent = session?.orchestratorStatus ?? '— Aguardando tarefa';
		this.orchestratorStatusEl.classList.toggle('complete', session?.complete ?? false);

		if (this.copyMdBtn) { this.copyMdBtn.disabled = !session; }
		if (this.copyJsonBtn) { this.copyJsonBtn.disabled = !session; }

		dom.clearNode(this.agentsEl);
		this.agentsEl.classList.toggle('compact', this.isCompact);

		if (!session || session.plan.agents.length === 0) {
			const emptyDiv = dom.append(this.agentsEl, dom.$('.neo-swarm-empty'));
			dom.append(emptyDiv, dom.$('div.neo-swarm-empty-icon', undefined, '🤖'));
			dom.append(emptyDiv, dom.$('div', undefined, 'NeoCode Swarm'));
			dom.append(emptyDiv, dom.$('div', undefined, 'Use @neo no chat para iniciar uma tarefa.'));
			this.timingEl.style.display = 'none';
			return;
		}

		for (const agentPlan of session.plan.agents) {
			const state = session.agentStates.get(agentPlan.id);
			if (state) {
				this.renderAgentCard(this.agentsEl, state);
			}
		}

		// Timing footer
		if (session.endTime) {
			const durationSec = Math.round((session.endTime - session.startTime) / 1000);
			const n = session.plan.agents.length;
			this.timingEl.textContent = `✅ Concluído em ${durationSec}s com ${n} agente${n !== 1 ? 's' : ''}`;
		} else {
			const elapsedSec = Math.round((Date.now() - session.startTime) / 1000);
			this.timingEl.textContent = `⏱️ Em execução há ${elapsedSec}s`;
		}
		this.timingEl.style.display = 'block';
	}

	private renderAgentCard(parent: HTMLElement, state: ISwarmAgentState): void {
		const card = dom.append(parent, dom.$('.neo-agent-card'));
		card.classList.add(`status-${state.status}`);

		// Header
		const header = dom.append(card, dom.$('.neo-agent-header'));
		dom.append(header, dom.$('span.neo-agent-emoji', undefined, state.plan.emoji));
		dom.append(header, dom.$('span.neo-agent-name', undefined, state.plan.name));
		dom.append(header, dom.$('span.neo-agent-role', undefined, state.plan.role));
		const badge = dom.append(header, dom.$('span.neo-agent-status-badge'));
		badge.textContent = this.statusLabel(state.status);

		// Task
		const taskEl = dom.append(card, dom.$('.neo-agent-task'));
		taskEl.textContent = state.plan.task.length > 120
			? `${state.plan.task.substring(0, 120)}...`
			: state.plan.task;

		// Log (last 15 entries)
		const logEl = dom.append(card, dom.$('.neo-agent-log'));
		for (const log of state.logs.slice(-15)) {
			this.renderLogEntry(logEl, log);
		}
		logEl.scrollTop = logEl.scrollHeight;
	}

	private renderLogEntry(parent: HTMLElement, log: ISwarmAgentLogEntry): void {
		const entry = dom.append(parent, dom.$('.neo-log-entry'));
		entry.classList.add(log.type);
		dom.append(entry, dom.$('span.neo-log-icon', undefined, this.logIcon(log.type)));
		dom.append(entry, dom.$('span', undefined, log.content));
	}

	private statusLabel(status: SwarmAgentStatus): string {
		switch (status) {
			case 'pending': return '⏳ Aguardando';
			case 'thinking': return '💭 Pensando';
			case 'working': return '⚙️ Trabalhando';
			case 'done': return '✅ Concluído';
			case 'error': return '❌ Erro';
		}
	}

	private logIcon(type: ISwarmAgentLogEntry['type']): string {
		switch (type) {
			case 'thinking': return '💭';
			case 'tool': return '🔧';
			case 'message': return '💬';
			case 'error': return '❌';
		}
	}

	private copyAsMarkdown(session: ISwarmActivitySession): void {
		let md = `# NeoCode Swarm Activity Session\n\n`;
		md += `**Status:** ${session.orchestratorStatus}\n`;
		md += `**Started:** ${new Date(session.startTime).toLocaleString()}\n`;
		if (session.endTime) {
			md += `**Finished:** ${new Date(session.endTime).toLocaleString()}\n`;
			md += `**Duration:** ${Math.round((session.endTime - session.startTime) / 1000)}s\n`;
		}
		md += `\n---\n\n`;

		for (const agentPlan of session.plan.agents) {
			const state = session.agentStates.get(agentPlan.id);
			if (!state) { continue; }

			md += `## ${agentPlan.emoji} ${agentPlan.name} (${agentPlan.role})\n`;
			md += `**Status:** ${state.status}\n`;
			md += `**Task:** ${agentPlan.task}\n\n`;

			if (state.logs.length > 0) {
				md += `### Activity Log\n`;
				for (const log of state.logs) {
					const icon = this.logIcon(log.type);
					md += `- ${icon} ${log.content}\n`;
				}
				md += `\n`;
			}

			if (state.result) {
				md += `### Final Result\n${state.result}\n\n`;
			}

			if (state.error) {
				md += `### Error\n${state.error}\n\n`;
			}

			md += `---\n\n`;
		}

		this.clipboardService.writeText(md);
		this.notificationService.info(localize('neoSwarmCopiedMd', "Activity summary copied as Markdown."));
	}

	private copyAsJson(session: ISwarmActivitySession): void {
		const json = JSON.stringify({
			sessionId: session.sessionId,
			orchestratorStatus: session.orchestratorStatus,
			startTime: session.startTime,
			endTime: session.endTime,
			complete: session.complete,
			plan: session.plan,
			agentStates: Array.from(session.agentStates.entries()).map(([id, state]) => ({
				agentId: id,
				status: state.status,
				logs: state.logs,
				result: state.result,
				error: state.error
			}))
		}, null, 2);

		this.clipboardService.writeText(json);
		this.notificationService.info(localize('neoSwarmCopiedJson', "Raw activity data copied as JSON."));
	}
}

// ─── Factory helper used by contribution ─────────────────────────────────

export function createActivityEditorInput(instantiationService: IInstantiationService): NeocodeSwarmActivityEditorInput {
	return instantiationService.createInstance(NeocodeSwarmActivityEditorInput);
}

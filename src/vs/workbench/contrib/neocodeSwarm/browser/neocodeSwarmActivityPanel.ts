/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
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
	ISwarmOrchestratorLogEntry,
} from '../common/neocodeSwarmTypes.js';

import './media/neocodeSwarmActivityPanel.css';

export class NeocodeSwarmActivityEditorInput extends EditorInput {
	static readonly ID = 'workbench.input.neocodeSwarmActivity';

	override get typeId(): string { return NeocodeSwarmActivityEditorInput.ID; }
	override get editorId(): string { return NeocodeSwarmActivityEditorInput.ID; }
	override getName(): string { return localize('neoSwarmActivityTitle', 'NeoCode Swarm Activity'); }
	override getDescription(): string { return localize('neoSwarmActivityDesc', 'Real-time swarm agent activity'); }
	override isDirty(): boolean { return false; }
	override readonly resource = URI.from({ scheme: 'neocode-swarm', path: 'activity' });
	override matches(other: EditorInput): boolean {
		return other instanceof NeocodeSwarmActivityEditorInput;
	}
}

export class NeocodeSwarmActivityEditorPane extends EditorPane {
	static readonly ID = 'workbench.editor.neocodeSwarmActivity';

	private container: HTMLElement | undefined;
	private orchestratorStatusEl: HTMLElement | undefined;
	private summaryBarEl: HTMLElement | undefined;
	private orchestratorHistoryEl: HTMLElement | undefined;
	private agentsEl: HTMLElement | undefined;
	private timingEl: HTMLElement | undefined;

	private countTotalEl: HTMLElement | undefined;
	private countDoneEl: HTMLElement | undefined;
	private countWorkingEl: HTMLElement | undefined;
	private countErrorEl: HTMLElement | undefined;
	private countTokensEl: HTMLElement | undefined;

	private copyMdBtn: HTMLButtonElement | undefined;
	private copyJsonBtn: HTMLButtonElement | undefined;
	private toggleHistoryBtn: HTMLButtonElement | undefined;
	private isCompact = true;
	private isHistoryMinimized = false;
	private timer: any | undefined;
	private currentSession: ISwarmActivitySession | undefined;
	private readonly expandedAgentLogs = new Set<string>();
	private readonly expandedOrchestratorLogs = new Set<number>();

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
		this.container = dom.append(parent, dom.$('.neo-swarm-activity'));

		const header = dom.append(this.container, dom.$('.neo-swarm-header'));
		const headerMain = dom.append(header, dom.$('.neo-swarm-header-main'));
		dom.append(headerMain, dom.$('span.neo-swarm-title', undefined, 'NEOCODE SWARM DASHBOARD'));
		this.orchestratorStatusEl = dom.append(headerMain, dom.$('span.neo-swarm-orchestrator-status'));
		this.orchestratorStatusEl.textContent = '— Aguardando tarefa';

		const actions = dom.append(headerMain, dom.$('.neo-swarm-actions'));
		this.toggleHistoryBtn = dom.append(actions, dom.$('button.neo-swarm-action-btn', undefined, 'Detalhes: ON')) as HTMLButtonElement;
		this.copyMdBtn = dom.append(actions, dom.$('button.neo-swarm-action-btn', undefined, 'Copy MD')) as HTMLButtonElement;
		this.copyJsonBtn = dom.append(actions, dom.$('button.neo-swarm-action-btn', undefined, 'Copy JSON')) as HTMLButtonElement;

		this._register(dom.addDisposableListener(this.toggleHistoryBtn, dom.EventType.CLICK, () => {
			this.isHistoryMinimized = !this.isHistoryMinimized;
			this.toggleHistoryBtn!.textContent = this.isHistoryMinimized ? 'Detalhes: OFF' : 'Detalhes: ON';
			this.renderSession(this.currentSession);
		}));

		this._register(dom.addDisposableListener(this.copyMdBtn, dom.EventType.CLICK, () => {
			const session = this.activityService.getCurrentSession();
			if (session) { this.copyAsMarkdown(session); }
		}));

		this._register(dom.addDisposableListener(this.copyJsonBtn, dom.EventType.CLICK, () => {
			const session = this.activityService.getCurrentSession();
			if (session) { this.copyAsJson(session); }
		}));

		this.summaryBarEl = dom.append(header, dom.$('.neo-swarm-summary-bar'));
		this.countTotalEl = this.createSummaryItem(this.summaryBarEl, 'Total', 'dot-total');
		this.countWorkingEl = this.createSummaryItem(this.summaryBarEl, 'Trabalhando', 'dot-working');
		this.countDoneEl = this.createSummaryItem(this.summaryBarEl, 'Concluídos', 'dot-done');
		this.countErrorEl = this.createSummaryItem(this.summaryBarEl, 'Erros', 'dot-error');
		this.countTokensEl = this.createSummaryItem(this.summaryBarEl, 'Tokens', 'dot-token');

		this.orchestratorHistoryEl = dom.append(this.container, dom.$('.neo-orchestrator-history'));
		this.agentsEl = dom.append(this.container, dom.$('.neo-swarm-agents'));
		this.timingEl = dom.append(this.container, dom.$('.neo-swarm-timing'));
		this.timingEl.style.display = 'none';

		this._register(this.activityService.onDidChange(session => this.renderSession(session)));
		this.renderSession(this.activityService.getCurrentSession());
		this.startTimer();
	}

	private createSummaryItem(parent: HTMLElement, label: string, dotClass: string): HTMLElement {
		const item = dom.append(parent, dom.$('.neo-summary-item'));
		dom.append(item, dom.$(`.neo-summary-dot.${dotClass}`));
		dom.append(item, dom.$('span', undefined, `${label}: `));
		return dom.append(item, dom.$('span.neo-summary-count', undefined, '0'));
	}

	private startTimer(): void {
		if (this.timer) { return; }
		this.timer = setInterval(() => this.updateTiming(), 1000);
	}

	override layout(dimension: Dimension): void {
		if (!this.agentsEl) { return; }
		const compact = dimension.width <= 760;
		if (compact !== this.isCompact) {
			this.isCompact = compact;
			this.agentsEl.classList.toggle('compact', compact);
		}
	}

	private renderSession(session: ISwarmActivitySession | undefined): void {
		this.currentSession = session;
		if (!this.container || !this.agentsEl || !this.orchestratorHistoryEl || !this.orchestratorStatusEl || !this.timingEl) {
			return;
		}

		this.orchestratorStatusEl.textContent = session?.orchestratorStatus ?? '— Aguardando tarefa';
		this.orchestratorStatusEl.classList.toggle('complete', session?.complete ?? false);
		this.container.classList.toggle('history-minimized', this.isHistoryMinimized);

		if (this.copyMdBtn) { this.copyMdBtn.disabled = !session; }
		if (this.copyJsonBtn) { this.copyJsonBtn.disabled = !session; }

		dom.clearNode(this.orchestratorHistoryEl);
		dom.clearNode(this.agentsEl);

		if (!session || session.plan.agents.length === 0) {
			this.renderEmptyState();
			this.timingEl.style.display = 'none';
			this.updateSummaryCounts(0, 0, 0, 0, 0);
			return;
		}

		this.renderOrchestratorHistory(session);

		let working = 0;
		let done = 0;
		let error = 0;
		for (const agentPlan of session.plan.agents) {
			const state = session.agentStates.get(agentPlan.id);
			if (!state) { continue; }
			if (state.status === 'working' || state.status === 'thinking') { working++; }
			else if (state.status === 'done') { done++; }
			else if (state.status === 'error') { error++; }
			this.renderAgentCard(this.agentsEl, state);
		}

		this.updateSummaryCounts(session.plan.agents.length, working, done, error, session.tokenUsage.totalTokens);
		this.updateTiming();
	}

	private renderEmptyState(): void {
		if (!this.orchestratorHistoryEl || !this.agentsEl) { return; }
		const historyEmpty = dom.append(this.orchestratorHistoryEl, dom.$('.neo-history-empty'));
		dom.append(historyEmpty, dom.$('div', undefined, 'Histórico do orquestrador aparecerá aqui quando a execução iniciar.'));

		const emptyDiv = dom.append(this.agentsEl, dom.$('.neo-swarm-empty'));
		dom.append(emptyDiv, dom.$('div.neo-swarm-empty-icon', undefined, '🤖'));
		dom.append(emptyDiv, dom.$('div', undefined, 'NeoCode Swarm Dashboard'));
		dom.append(emptyDiv, dom.$('div', undefined, 'Inicie uma tarefa para visualizar a atividade detalhada.'));
	}

	private renderOrchestratorHistory(session: ISwarmActivitySession): void {
		if (!this.orchestratorHistoryEl) { return; }
		const header = dom.append(this.orchestratorHistoryEl, dom.$('.neo-history-header'));
		dom.append(header, dom.$('span.neo-history-title', undefined, 'Histórico do Orquestrador'));
		dom.append(header, dom.$('span.neo-history-count', undefined, `${session.orchestratorLogs.length} eventos`));

		if (session.orchestratorLogs.length === 0) {
			dom.append(this.orchestratorHistoryEl, dom.$('.neo-history-empty', undefined, 'Sem eventos do orquestrador ainda.'));
			return;
		}

		const list = dom.append(this.orchestratorHistoryEl, dom.$('.neo-history-list'));
		const visibleLogs = this.isHistoryMinimized
			? session.orchestratorLogs.slice(-1)
			: session.orchestratorLogs.slice(-60);

		for (const log of visibleLogs) {
			this.renderOrchestratorLog(list, log);
		}
	}

	private renderOrchestratorLog(parent: HTMLElement, log: ISwarmOrchestratorLogEntry): void {
		const entry = dom.append(parent, dom.$(`.neo-orchestrator-entry.kind-${log.kind}`));
		dom.append(entry, dom.$('span.neo-orchestrator-icon', undefined, this.orchestratorIcon(log.kind)));
		const body = dom.append(entry, dom.$('.neo-orchestrator-body'));
		dom.append(body, dom.$('div.neo-orchestrator-main', undefined, log.content));
		dom.append(body, dom.$('div.neo-orchestrator-meta', undefined, this.formatMeta(log)));

		if (log.details) {
			const key = log.timestamp;
			const expanded = this.expandedOrchestratorLogs.has(key);
			const details = dom.append(body, dom.$('div.neo-expandable'));
			const btn = dom.append(details, dom.$('button.neo-expand-btn', undefined, expanded ? 'Ocultar detalhes' : 'Ver detalhes')) as HTMLButtonElement;
			const content = dom.append(details, dom.$('pre.neo-expand-content'));
			content.textContent = log.details;
			content.style.display = expanded ? 'block' : 'none';
			dom.addDisposableListener(btn, dom.EventType.CLICK, () => {
				if (this.expandedOrchestratorLogs.has(key)) {
					this.expandedOrchestratorLogs.delete(key);
					btn.textContent = 'Ver detalhes';
					content.style.display = 'none';
				} else {
					this.expandedOrchestratorLogs.add(key);
					btn.textContent = 'Ocultar detalhes';
					content.style.display = 'block';
				}
			});
		}
	}

	private updateSummaryCounts(total: number, working: number, done: number, error: number, tokens: number): void {
		if (this.countTotalEl) { this.countTotalEl.textContent = String(total); }
		if (this.countWorkingEl) { this.countWorkingEl.textContent = String(working); }
		if (this.countDoneEl) { this.countDoneEl.textContent = String(done); }
		if (this.countErrorEl) { this.countErrorEl.textContent = String(error); }
		if (this.countTokensEl) { this.countTokensEl.textContent = this.formatCompactNumber(tokens); }
		if (this.summaryBarEl) {
			this.summaryBarEl.style.display = total > 0 ? 'flex' : 'none';
		}
	}

	private updateTiming(): void {
		if (!this.timingEl || !this.currentSession) {
			if (this.timingEl) { this.timingEl.style.display = 'none'; }
			return;
		}

		const session = this.currentSession;
		if (session.endTime) {
			const durationSec = Math.round((session.endTime - session.startTime) / 1000);
			const n = session.plan.agents.length;
			let text = `Concluído em ${this.formatDuration(durationSec)}`;
			if (session.budgetSeconds) {
				text += ` (orçamento: ${this.formatDuration(session.budgetSeconds)})`;
			}
			text += ` | ${n} agentes`;
			text += ` | ${this.formatTokenUsage(session.tokenUsage)}`;
			this.timingEl.textContent = text;
		} else {
			const elapsedSec = Math.round((Date.now() - session.startTime) / 1000);
			let text = `Ativo há ${this.formatDuration(elapsedSec)}`;
			if (session.budgetSeconds) {
				text += ` de ${this.formatDuration(session.budgetSeconds)}`;
			}
			text += ` | ${this.formatTokenUsage(session.tokenUsage)}`;
			this.timingEl.textContent = text;
		}
		this.timingEl.style.display = 'flex';
	}

	private formatDuration(seconds: number): string {
		if (seconds < 60) {
			return `${seconds}s`;
		}
		const mins = Math.floor(seconds / 60);
		const secs = seconds % 60;
		if (secs === 0) {
			return `${mins} min`;
		}
		return `${mins} min ${secs}s`;
	}

	private renderAgentCard(parent: HTMLElement, state: ISwarmAgentState): void {
		const card = dom.append(parent, dom.$('.neo-agent-card'));
		card.classList.add(`status-${state.status}`);

		const header = dom.append(card, dom.$('.neo-agent-header'));
		dom.append(header, dom.$('span.neo-agent-emoji', undefined, state.plan.emoji));
		const info = dom.append(header, dom.$('.neo-agent-info'));
		dom.append(info, dom.$('span.neo-agent-name', undefined, state.plan.name));
		dom.append(info, dom.$('span.neo-agent-role', undefined, state.plan.role));
		dom.append(header, dom.$('span.neo-agent-status-badge', undefined, this.statusLabel(state.status)));

		const task = dom.append(card, dom.$('.neo-agent-task'));
		task.textContent = state.plan.task;

		const logHeader = dom.append(card, dom.$('.neo-agent-log-header'));
		dom.append(logHeader, dom.$('span', undefined, `Histórico do agente (${state.logs.length})`));
		if (state.tokenUsage.totalTokens > 0) {
			dom.append(logHeader, dom.$('span.neo-agent-token-usage', undefined, this.formatTokenUsage(state.tokenUsage)));
		}

		const expanded = this.expandedAgentLogs.has(state.plan.id);
		const needsCollapse = !this.isHistoryMinimized && state.logs.length > 8;
		if (needsCollapse) {
			const toggle = dom.append(logHeader, dom.$('button.neo-expand-btn', undefined, expanded ? 'Mostrar menos' : 'Mostrar tudo')) as HTMLButtonElement;
			dom.addDisposableListener(toggle, dom.EventType.CLICK, () => {
				if (this.expandedAgentLogs.has(state.plan.id)) {
					this.expandedAgentLogs.delete(state.plan.id);
				} else {
					this.expandedAgentLogs.add(state.plan.id);
				}
				this.renderSession(this.currentSession);
			});
		}

		const logEl = dom.append(card, dom.$('.neo-agent-log'));
		const visibleLogs = this.isHistoryMinimized
			? state.logs.slice(-2)
			: (expanded ? state.logs : state.logs.slice(-8));
		for (const log of visibleLogs) {
			this.renderLogEntry(logEl, log);
		}
		logEl.scrollTop = logEl.scrollHeight;
	}

	private renderLogEntry(parent: HTMLElement, log: ISwarmAgentLogEntry): void {
		const logClass = log.type === 'thinking'
			? 'thinking'
			: log.type === 'error'
				? 'error'
				: log.type === 'tool'
					? 'tool'
					: '';
		const entry = dom.append(parent, dom.$(`.neo-log-entry${logClass ? '.' + logClass : ''}`));
		dom.append(entry, dom.$('span.neo-log-icon', undefined, this.logIcon(log.type)));

		const body = dom.append(entry, dom.$('.neo-log-body'));
		dom.append(body, dom.$('div.neo-log-main', undefined, log.content));
		dom.append(body, dom.$('div.neo-log-time', undefined, this.formatClock(log.timestamp)));

		if (log.details) {
			const detailsText = this.stringifyToolDetails(log.details);
			const detailsWrap = dom.append(body, dom.$('.neo-expandable'));
			const btn = dom.append(detailsWrap, dom.$('button.neo-expand-btn', undefined, 'Ver payload da ferramenta')) as HTMLButtonElement;
			const content = dom.append(detailsWrap, dom.$('pre.neo-expand-content'));
			content.textContent = detailsText;
			content.style.display = 'none';
			dom.addDisposableListener(btn, dom.EventType.CLICK, () => {
				const willShow = content.style.display !== 'block';
				content.style.display = willShow ? 'block' : 'none';
				btn.textContent = willShow ? 'Ocultar payload da ferramenta' : 'Ver payload da ferramenta';
			});
		}
	}

	private stringifyToolDetails(details: NonNullable<ISwarmAgentLogEntry['details']>): string {
		return JSON.stringify(details, null, 2);
	}

	private statusLabel(status: SwarmAgentStatus): string {
		switch (status) {
			case 'pending': return 'Pendente';
			case 'thinking': return 'Pensando';
			case 'working': return 'Executando';
			case 'done': return 'Concluído';
			case 'error': return 'Erro';
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

	private orchestratorIcon(kind: ISwarmOrchestratorLogEntry['kind']): string {
		switch (kind) {
			case 'status': return '🧭';
			case 'decision': return '🧠';
			case 'dispatch': return '🚀';
			case 'result': return '📦';
			case 'error': return '❌';
			case 'info': return 'ℹ️';
		}
	}

	private formatMeta(log: ISwarmOrchestratorLogEntry): string {
		const parts: string[] = [this.formatClock(log.timestamp)];
		if (typeof log.round === 'number') {
			parts.push(`rodada ${log.round}`);
		}
		if (log.agentId) {
			parts.push(log.agentId);
		}
		return parts.join(' • ');
	}

	private formatClock(timestamp: number): string {
		return new Date(timestamp).toLocaleTimeString();
	}

	private copyAsMarkdown(session: ISwarmActivitySession): void {
		let md = `# NeoCode Swarm Activity Session\n\n`;
		md += `**Status:** ${session.orchestratorStatus}\n`;
		md += `**Started:** ${new Date(session.startTime).toLocaleString()}\n`;
		md += `**Tokens:** ${this.formatTokenUsage(session.tokenUsage)}\n`;
		if (session.endTime) {
			md += `**Finished:** ${new Date(session.endTime).toLocaleString()}\n`;
			md += `**Duration:** ${Math.round((session.endTime - session.startTime) / 1000)}s\n`;
		}
		md += `\n## Orchestrator History\n`;
		for (const log of session.orchestratorLogs) {
			md += `- ${this.orchestratorIcon(log.kind)} ${log.content}`;
			if (log.round !== undefined) { md += ` (round ${log.round})`; }
			if (log.agentId) { md += ` [${log.agentId}]`; }
			md += '\n';
			if (log.details) {
				md += `  - details: \`${log.details.replace(/`/g, '\\`')}\`\n`;
			}
		}
		md += '\n---\n\n';

		for (const agentPlan of session.plan.agents) {
			const state = session.agentStates.get(agentPlan.id);
			if (!state) { continue; }

			md += `## ${agentPlan.emoji} ${agentPlan.name} (${agentPlan.role})\n`;
			md += `**Status:** ${state.status}\n`;
			md += `**Task:** ${agentPlan.task}\n\n`;
			md += `**Tokens:** ${this.formatTokenUsage(state.tokenUsage)}\n\n`;
			if (state.logs.length > 0) {
				md += `### Activity Log\n`;
				for (const log of state.logs) {
					md += `- ${this.logIcon(log.type)} ${log.content}\n`;
					if (log.details) {
						md += `  - details: \`${this.stringifyToolDetails(log.details).replace(/`/g, '\\`')}\`\n`;
					}
				}
				md += '\n';
			}
			if (state.result) { md += `### Final Result\n${state.result}\n\n`; }
			if (state.error) { md += `### Error\n${state.error}\n\n`; }
			md += '---\n\n';
		}

		this.clipboardService.writeText(md);
		this.notificationService.info(localize('neoSwarmCopiedMd', 'Activity summary copied as Markdown.'));
	}

	private copyAsJson(session: ISwarmActivitySession): void {
		const json = JSON.stringify({
			sessionId: session.sessionId,
			orchestratorStatus: session.orchestratorStatus,
			orchestratorLogs: session.orchestratorLogs,
			startTime: session.startTime,
			endTime: session.endTime,
			complete: session.complete,
			tokenUsage: session.tokenUsage,
			plan: session.plan,
			agentStates: Array.from(session.agentStates.entries()).map(([id, state]) => ({
				agentId: id,
				status: state.status,
				tokenUsage: state.tokenUsage,
				logs: state.logs,
				result: state.result,
				error: state.error,
			})),
		}, null, 2);

		this.clipboardService.writeText(json);
		this.notificationService.info(localize('neoSwarmCopiedJson', 'Raw activity data copied as JSON.'));
	}

	override dispose(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		super.dispose();
	}

	private formatCompactNumber(value: number): string {
		return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(Math.max(0, Math.floor(value)));
	}

	private formatTokenUsage(usage: { promptTokens: number; completionTokens: number; totalTokens: number }): string {
		const prompt = this.formatCompactNumber(usage.promptTokens);
		const completion = this.formatCompactNumber(usage.completionTokens);
		const total = this.formatCompactNumber(usage.totalTokens);
		return `tokens ${total} (in ${prompt} / out ${completion})`;
	}
}

export function createActivityEditorInput(instantiationService: IInstantiationService): NeocodeSwarmActivityEditorInput {
	return instantiationService.createInstance(NeocodeSwarmActivityEditorInput);
}

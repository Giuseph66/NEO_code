/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import {
	ISwarmExecutionPlan,
	ISwarmAgentPlan,
	ISwarmAgentState,
	ISwarmActivitySession,
	ISwarmOrchestratorLogEntry,
	ISwarmTokenUsage,
} from '../common/neocodeSwarmTypes.js';
import { IAgentProgressUpdate } from './neocodeSwarmAgentRunner.js';

export const INeocodeSwarmActivityService = createDecorator<INeocodeSwarmActivityService>('neocodeSwarmActivityService');

export interface INeocodeSwarmActivityService {
	readonly _serviceBrand: undefined;

	/** Fired whenever any session state changes. */
	readonly onDidChange: Event<ISwarmActivitySession>;
	/** Fired when a new session with agents starts (triggers panel auto-open). */
	readonly onDidStartSession: Event<ISwarmActivitySession>;

	startSession(sessionId: string, plan: ISwarmExecutionPlan, budgetSeconds?: number): void;
	addAgent(sessionId: string, plan: ISwarmAgentPlan): void;
	updateAgent(sessionId: string, update: IAgentProgressUpdate): void;
	appendOrchestratorLog(sessionId: string, entry: Omit<ISwarmOrchestratorLogEntry, 'timestamp'> & { timestamp?: number }): void;
	setOrchestratorStatus(sessionId: string, status: string): void;
	completeSession(sessionId: string): void;
	getCurrentSession(): ISwarmActivitySession | undefined;
}

export class NeocodeSwarmActivityService extends Disposable implements INeocodeSwarmActivityService {
	readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<ISwarmActivitySession>());
	readonly onDidChange = this._onDidChange.event;

	private readonly _onDidStartSession = this._register(new Emitter<ISwarmActivitySession>());
	readonly onDidStartSession = this._onDidStartSession.event;

	private _currentSession: ISwarmActivitySession | undefined;

	constructor() {
		super();
	}

	startSession(sessionId: string, plan: ISwarmExecutionPlan, budgetSeconds?: number): void {
		const agentStates = new Map<string, ISwarmAgentState>();
		for (const agentPlan of plan.agents) {
			agentStates.set(agentPlan.id, {
				plan: agentPlan,
				status: 'pending',
				logs: [],
				tokenUsage: this.createZeroTokenUsage(),
			});
		}

		this._currentSession = {
			sessionId,
			plan,
			agentStates,
			tokenUsage: this.createZeroTokenUsage(),
			orchestratorLogs: [],
			orchestratorStatus: '🚀 Despachando agentes...',
			startTime: Date.now(),
			budgetSeconds,
			complete: false,
		};

		this._onDidChange.fire(this._currentSession);
		this._onDidStartSession.fire(this._currentSession);
	}

	addAgent(sessionId: string, plan: ISwarmAgentPlan): void {
		if (this._currentSession?.sessionId !== sessionId) { return; }
		if (this._currentSession.agentStates.has(plan.id)) { return; }

		if (!this._currentSession.plan.agents.some(agent => agent.id === plan.id)) {
			this._currentSession.plan.agents.push(plan);
		}
		this._currentSession.agentStates.set(plan.id, {
			plan,
			status: 'pending',
			logs: [],
			tokenUsage: this.createZeroTokenUsage(),
		});
		this.recomputeSessionTokenUsage();
		this._onDidChange.fire(this._currentSession);
	}

	updateAgent(sessionId: string, update: IAgentProgressUpdate): void {
		if (this._currentSession?.sessionId !== sessionId) { return; }

		const state = this._currentSession.agentStates.get(update.agentId);
		if (!state) { return; }

		state.status = update.status;
		if (update.tokenUsage) {
			state.tokenUsage = {
				promptTokens: Math.max(0, Math.floor(update.tokenUsage.promptTokens)),
				completionTokens: Math.max(0, Math.floor(update.tokenUsage.completionTokens)),
				totalTokens: Math.max(0, Math.floor(update.tokenUsage.totalTokens)),
			};
		}
		if (update.log) {
			state.logs.push(update.log);
			// Keep a larger buffer so the user can inspect detailed history.
			if (state.logs.length > 250) {
				state.logs.splice(0, state.logs.length - 250);
			}
		}

		if (update.status === 'done') {
			const content = state.logs
				.filter(l => l.type === 'message')
				.map(l => l.content)
				.join('\n');
			state.result = content;
		} else if (update.status === 'error') {
			const errorLog = state.logs.find(l => l.type === 'error');
			state.error = errorLog?.content;
		}

		this.recomputeSessionTokenUsage();

		this._onDidChange.fire(this._currentSession);
	}

	appendOrchestratorLog(sessionId: string, entry: Omit<ISwarmOrchestratorLogEntry, 'timestamp'> & { timestamp?: number }): void {
		if (this._currentSession?.sessionId !== sessionId) { return; }
		this._currentSession.orchestratorLogs.push({
			...entry,
			timestamp: entry.timestamp ?? Date.now(),
		});
		if (this._currentSession.orchestratorLogs.length > 400) {
			this._currentSession.orchestratorLogs.splice(0, this._currentSession.orchestratorLogs.length - 400);
		}
		this._onDidChange.fire(this._currentSession);
	}

	setOrchestratorStatus(sessionId: string, status: string): void {
		if (this._currentSession?.sessionId !== sessionId) { return; }
		this._currentSession.orchestratorStatus = status;
		this._onDidChange.fire(this._currentSession);
	}

	completeSession(sessionId: string): void {
		if (this._currentSession?.sessionId !== sessionId) { return; }
		this._currentSession.complete = true;
		this._currentSession.endTime = Date.now();
		this._onDidChange.fire(this._currentSession);
	}

	getCurrentSession(): ISwarmActivitySession | undefined {
		return this._currentSession;
	}

	private createZeroTokenUsage(): ISwarmTokenUsage {
		return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
	}

	private recomputeSessionTokenUsage(): void {
		if (!this._currentSession) { return; }
		let promptTokens = 0;
		let completionTokens = 0;
		let totalTokens = 0;
		for (const state of this._currentSession.agentStates.values()) {
			promptTokens += state.tokenUsage.promptTokens;
			completionTokens += state.tokenUsage.completionTokens;
			totalTokens += state.tokenUsage.totalTokens;
		}
		this._currentSession.tokenUsage = {
			promptTokens,
			completionTokens,
			totalTokens,
		};
	}
}

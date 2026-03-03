/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import './media/neocodeSwarmVoiceInputModal.css';

export interface INeocodeSwarmVoiceInputResult {
	transcription: string;
	sendImmediately: boolean;
}

export class NeocodeSwarmVoiceInputModal extends Disposable {
	private overlay: HTMLElement | undefined;
	private container: HTMLElement | undefined;
	private statusEl: HTMLElement | undefined;
	private timerEl: HTMLElement | undefined;
	private hintEl: HTMLElement | undefined;
	private audioPreviewEl: HTMLAudioElement | undefined;
	private textAreaEl: HTMLTextAreaElement | undefined;

	private recordButton: HTMLButtonElement | undefined;
	private stopButton: HTMLButtonElement | undefined;
	private transcribeButton: HTMLButtonElement | undefined;
	private transcribeAndSendButton: HTMLButtonElement | undefined;
	private insertButton: HTMLButtonElement | undefined;
	private sendButton: HTMLButtonElement | undefined;
	private cancelButton: HTMLButtonElement | undefined;

	private mediaRecorder: MediaRecorder | undefined;
	private mediaStream: MediaStream | undefined;
	private recordingChunks: BlobPart[] = [];
	private recordedBlob: Blob | undefined;
	private recordedAudioUrl: string | undefined;
	private recordingStartedAt = 0;
	private recordingTicker: number | undefined;
	private autoStopTimer: number | undefined;
	private stopPromise: Promise<void> | undefined;
	private stopPromiseResolver: (() => void) | undefined;
	private transcribing = false;
	private transcriptionText = '';

	private resolveResult: ((value: INeocodeSwarmVoiceInputResult | undefined) => void) | undefined;

	constructor(
		private readonly transcribeAudio: (audioBlob: Blob) => Promise<string>,
		private readonly maxDurationMs: number = 2 * 60 * 1000,
	) {
		super();
	}

	async show(): Promise<INeocodeSwarmVoiceInputResult | undefined> {
		return new Promise(resolve => {
			this.resolveResult = resolve;
			this.create();
			this.render();
		});
	}

	private create(): void {
		this.overlay = dom.append(document.body, dom.$('.neo-voice-modal-overlay'));
		this._register(dom.addDisposableListener(this.overlay, dom.EventType.CLICK, event => {
			if (event.target === this.overlay) {
				this.cancel();
			}
		}));

		this.container = dom.append(this.overlay, dom.$('.neo-voice-modal-container'));

		const header = dom.append(this.container, dom.$('.neo-voice-modal-header'));
		dom.append(header, dom.$('.neo-voice-modal-icon', undefined, '🎙️'));
		const titleBlock = dom.append(header, dom.$('.neo-voice-modal-title-block'));
		dom.append(titleBlock, dom.$('h2', undefined, localize('neoVoice.title', 'Gravar Audio para NeoCode')));
		dom.append(titleBlock, dom.$('p', undefined, localize('neoVoice.subtitle', 'Limite maximo: 2 minutos.')));

		const body = dom.append(this.container, dom.$('.neo-voice-modal-body'));
		this.statusEl = dom.append(body, dom.$('.neo-voice-status'));
		this.timerEl = dom.append(body, dom.$('.neo-voice-timer'));
		this.hintEl = dom.append(body, dom.$('.neo-voice-hint'));

		this.audioPreviewEl = dom.append(body, dom.$('audio.neo-voice-audio-preview')) as HTMLAudioElement;
		this.audioPreviewEl.controls = true;
		this.audioPreviewEl.hidden = true;

		this.textAreaEl = dom.append(body, dom.$('textarea.neo-voice-transcription')) as HTMLTextAreaElement;
		this.textAreaEl.rows = 8;
		this.textAreaEl.hidden = true;
		this.textAreaEl.placeholder = localize('neoVoice.textPlaceholder', 'A transcricao aparecera aqui.');

		const actions = dom.append(this.container, dom.$('.neo-voice-modal-actions'));
		this.recordButton = dom.append(actions, dom.$('button.neo-voice-btn.primary', { type: 'button' }, localize('neoVoice.startRecording', 'Iniciar gravacao'))) as HTMLButtonElement;
		this.stopButton = dom.append(actions, dom.$('button.neo-voice-btn', { type: 'button' }, localize('neoVoice.stopRecording', 'Parar gravacao'))) as HTMLButtonElement;
		this.transcribeButton = dom.append(actions, dom.$('button.neo-voice-btn', { type: 'button' }, localize('neoVoice.transcribe', 'Transcrever'))) as HTMLButtonElement;
		this.transcribeAndSendButton = dom.append(actions, dom.$('button.neo-voice-btn', { type: 'button' }, localize('neoVoice.transcribeAndSend', 'Transcrever e enviar'))) as HTMLButtonElement;
		this.insertButton = dom.append(actions, dom.$('button.neo-voice-btn', { type: 'button' }, localize('neoVoice.insertInChat', 'Inserir no chat'))) as HTMLButtonElement;
		this.sendButton = dom.append(actions, dom.$('button.neo-voice-btn.primary', { type: 'button' }, localize('neoVoice.sendNow', 'Enviar agora'))) as HTMLButtonElement;
		this.cancelButton = dom.append(actions, dom.$('button.neo-voice-btn.danger', { type: 'button' }, localize('neoVoice.cancel', 'Cancelar'))) as HTMLButtonElement;

		this._register(dom.addDisposableListener(this.recordButton, dom.EventType.CLICK, () => void this.handleStartRecording()));
		this._register(dom.addDisposableListener(this.stopButton, dom.EventType.CLICK, () => void this.handleStopRecording(false)));
		this._register(dom.addDisposableListener(this.transcribeButton, dom.EventType.CLICK, () => void this.handleTranscribe(false)));
		this._register(dom.addDisposableListener(this.transcribeAndSendButton, dom.EventType.CLICK, () => void this.handleTranscribe(true)));
		this._register(dom.addDisposableListener(this.insertButton, dom.EventType.CLICK, () => this.confirm(false)));
		this._register(dom.addDisposableListener(this.sendButton, dom.EventType.CLICK, () => this.confirm(true)));
		this._register(dom.addDisposableListener(this.cancelButton, dom.EventType.CLICK, () => this.cancel()));
	}

	private async handleStartRecording(): Promise<void> {
		if (this.isRecording()) {
			return;
		}

		if (!navigator.mediaDevices?.getUserMedia) {
			this.setStatus(localize('neoVoice.mediaDevicesMissing', 'Seu ambiente nao suporta gravacao de audio.'));
			return;
		}

		if (typeof MediaRecorder === 'undefined') {
			this.setStatus(localize('neoVoice.mediaRecorderMissing', 'MediaRecorder nao esta disponivel neste ambiente.'));
			return;
		}

		try {
			this.recordedBlob = undefined;
			this.transcriptionText = '';
			this.recordingChunks = [];
			this.clearAudioPreview();
			this.hideTranscriptionEditor();

			this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
			const mimeType = this.pickMimeType();
			this.mediaRecorder = mimeType
				? new MediaRecorder(this.mediaStream, { mimeType })
				: new MediaRecorder(this.mediaStream);

			this.mediaRecorder.ondataavailable = event => {
				if (event.data && event.data.size > 0) {
					this.recordingChunks.push(event.data);
				}
			};

			this.mediaRecorder.onerror = () => {
				this.setStatus(localize('neoVoice.recordingError', 'Erro durante a gravacao de audio.'));
			};

			this.stopPromise = new Promise(resolve => {
				this.stopPromiseResolver = resolve;
			});

			this.mediaRecorder.onstop = () => {
				const mime = this.mediaRecorder?.mimeType || 'audio/webm';
				this.recordedBlob = new Blob(this.recordingChunks, { type: mime });
				this.stopPromiseResolver?.();
				this.stopPromiseResolver = undefined;
				this.stopMediaStream();
				if (this.recordedBlob && this.recordedBlob.size > 0) {
					this.showAudioPreview(this.recordedBlob);
				}
				this.render();
			};

			this.mediaRecorder.start(250);
			this.recordingStartedAt = Date.now();
			this.recordingTicker = window.setInterval(() => this.updateTimerLabel(), 200);
			this.autoStopTimer = window.setTimeout(() => {
				void this.handleStopRecording(true);
			}, this.maxDurationMs);
			this.setStatus(localize('neoVoice.recordingStarted', 'Gravando audio...'));
			this.updateTimerLabel();
			this.render();
		} catch (error) {
			this.setStatus(this.formatError(localize('neoVoice.startFailed', 'Nao foi possivel iniciar a gravacao.'), error));
			this.stopMediaStream();
			this.mediaRecorder = undefined;
			this.render();
		}
	}

	private async handleStopRecording(reachedLimit: boolean): Promise<void> {
		if (!this.isRecording() || !this.mediaRecorder) {
			return;
		}

		const recorder = this.mediaRecorder;
		this.clearRecordingTimers();

		if (recorder.state !== 'inactive') {
			recorder.stop();
		}

		if (this.stopPromise) {
			await this.stopPromise;
		}

		this.mediaRecorder = undefined;
		this.updateTimerLabel();

		if (!this.recordedBlob || this.recordedBlob.size <= 0) {
			this.setStatus(localize('neoVoice.emptyRecording', 'Nenhum audio foi capturado. Tente novamente.'));
			this.render();
			return;
		}

		if (reachedLimit) {
			this.setStatus(localize('neoVoice.autoStopped', 'Gravacao encerrada automaticamente apos 2 minutos.'));
		} else {
			this.setStatus(localize('neoVoice.recordingStopped', 'Gravacao finalizada. Escolha como transcrever.'));
		}
		this.render();
	}

	private async handleTranscribe(sendImmediately: boolean): Promise<void> {
		if (!this.recordedBlob || this.recordedBlob.size <= 0) {
			this.setStatus(localize('neoVoice.recordFirst', 'Grave um audio antes de transcrever.'));
			return;
		}
		if (this.transcribing) {
			return;
		}

		this.transcribing = true;
		this.setStatus(localize('neoVoice.transcribing', 'Transcrevendo audio...'));
		this.render();

		try {
			const text = (await this.transcribeAudio(this.recordedBlob)).trim();
			if (!text) {
				throw new Error(localize('neoVoice.emptyTranscription', 'A transcricao retornou vazia.'));
			}

			this.transcriptionText = text;
			this.showTranscriptionEditor(text);
			if (sendImmediately) {
				this.confirm(true);
				return;
			}

			this.setStatus(localize('neoVoice.transcriptionReady', 'Transcricao pronta. Revise e escolha inserir ou enviar.'));
		} catch (error) {
			this.setStatus(this.formatError(localize('neoVoice.transcriptionFailed', 'Falha ao transcrever o audio.'), error));
		} finally {
			this.transcribing = false;
			this.render();
		}
	}

	private confirm(sendImmediately: boolean): void {
		const text = (this.textAreaEl?.value || this.transcriptionText || '').trim();
		if (!text) {
			this.setStatus(localize('neoVoice.noTextToSend', 'Nao ha texto transcrito para enviar.'));
			return;
		}
		this.resolveResult?.({
			transcription: text,
			sendImmediately,
		});
		this.dispose();
	}

	private cancel(): void {
		this.resolveResult?.(undefined);
		this.dispose();
	}

	private render(): void {
		const hasRecording = !!this.recordedBlob && this.recordedBlob.size > 0;
		const hasTranscription = this.transcriptionText.trim().length > 0;
		const recording = this.isRecording();

		if (this.recordButton) {
			this.recordButton.hidden = recording;
			this.recordButton.disabled = this.transcribing;
		}
		if (this.stopButton) {
			this.stopButton.hidden = !recording;
			this.stopButton.disabled = !recording;
		}

		if (this.transcribeButton) {
			this.transcribeButton.hidden = !hasRecording || recording;
			this.transcribeButton.disabled = this.transcribing;
		}
		if (this.transcribeAndSendButton) {
			this.transcribeAndSendButton.hidden = !hasRecording || recording;
			this.transcribeAndSendButton.disabled = this.transcribing;
		}

		if (this.insertButton) {
			this.insertButton.hidden = !hasTranscription || recording;
			this.insertButton.disabled = this.transcribing;
		}
		if (this.sendButton) {
			this.sendButton.hidden = !hasTranscription || recording;
			this.sendButton.disabled = this.transcribing;
		}

		if (this.cancelButton) {
			this.cancelButton.disabled = this.transcribing;
		}

		if (this.hintEl) {
			if (recording) {
				this.hintEl.textContent = localize('neoVoice.hintRecording', 'Fale normalmente. O limite maximo e de 2 minutos por audio.');
			} else if (hasRecording) {
				this.hintEl.textContent = localize('neoVoice.hintRecorded', 'Voce pode transcrever antes de enviar ou transcrever e enviar direto.');
			} else {
				this.hintEl.textContent = localize('neoVoice.hintIdle', 'Clique em Iniciar gravacao para capturar o audio.');
			}
		}
	}

	private setStatus(message: string): void {
		if (this.statusEl) {
			this.statusEl.textContent = message;
		}
	}

	private updateTimerLabel(): void {
		if (!this.timerEl) {
			return;
		}
		const elapsedMs = this.isRecording()
			? Date.now() - this.recordingStartedAt
			: this.recordedBlob
				? Math.min(this.maxDurationMs, Date.now() - this.recordingStartedAt)
				: 0;
		const boundedElapsed = Math.max(0, Math.min(this.maxDurationMs, elapsedMs));
		this.timerEl.textContent = `${this.formatDuration(boundedElapsed)} / ${this.formatDuration(this.maxDurationMs)}`;
	}

	private formatDuration(ms: number): string {
		const totalSeconds = Math.floor(ms / 1000);
		const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
		const seconds = (totalSeconds % 60).toString().padStart(2, '0');
		return `${minutes}:${seconds}`;
	}

	private isRecording(): boolean {
		return !!this.mediaRecorder && this.mediaRecorder.state !== 'inactive';
	}

	private clearRecordingTimers(): void {
		if (this.recordingTicker !== undefined) {
			window.clearInterval(this.recordingTicker);
			this.recordingTicker = undefined;
		}
		if (this.autoStopTimer !== undefined) {
			window.clearTimeout(this.autoStopTimer);
			this.autoStopTimer = undefined;
		}
	}

	private stopMediaStream(): void {
		if (!this.mediaStream) {
			return;
		}
		for (const track of this.mediaStream.getTracks()) {
			track.stop();
		}
		this.mediaStream = undefined;
	}

	private pickMimeType(): string | undefined {
		const candidates = [
			'audio/webm;codecs=opus',
			'audio/webm',
			'audio/mp4',
		];
		for (const candidate of candidates) {
			if (MediaRecorder.isTypeSupported(candidate)) {
				return candidate;
			}
		}
		return undefined;
	}

	private showAudioPreview(blob: Blob): void {
		if (!this.audioPreviewEl) {
			return;
		}
		this.clearAudioPreview();
		this.recordedAudioUrl = URL.createObjectURL(blob);
		this.audioPreviewEl.src = this.recordedAudioUrl;
		this.audioPreviewEl.hidden = false;
	}

	private clearAudioPreview(): void {
		if (this.audioPreviewEl) {
			this.audioPreviewEl.pause();
			this.audioPreviewEl.currentTime = 0;
			this.audioPreviewEl.hidden = true;
			this.audioPreviewEl.removeAttribute('src');
			this.audioPreviewEl.load();
		}
		if (this.recordedAudioUrl) {
			URL.revokeObjectURL(this.recordedAudioUrl);
			this.recordedAudioUrl = undefined;
		}
	}

	private showTranscriptionEditor(text: string): void {
		if (!this.textAreaEl) {
			return;
		}
		this.textAreaEl.hidden = false;
		this.textAreaEl.value = text;
	}

	private hideTranscriptionEditor(): void {
		if (!this.textAreaEl) {
			return;
		}
		this.textAreaEl.value = '';
		this.textAreaEl.hidden = true;
	}

	private formatError(prefix: string, error: unknown): string {
		const detail = error instanceof Error ? error.message : String(error ?? '');
		if (!detail) {
			return prefix;
		}
		return `${prefix} ${detail}`;
	}

	override dispose(): void {
		super.dispose();
		this.clearRecordingTimers();
		if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
			this.mediaRecorder.stop();
		}
		this.mediaRecorder = undefined;
		this.stopMediaStream();
		this.clearAudioPreview();
		this.overlay?.remove();
	}
}

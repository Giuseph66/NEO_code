/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import './media/neocodeSwarmVoiceInlinePanel.css';

export interface INeocodeSwarmVoiceInlineResult {
	transcription: string;
	sendImmediately: boolean;
}

export class NeocodeSwarmVoiceInlinePanel extends Disposable {
	private host: HTMLElement | undefined;
	private root: HTMLElement | undefined;
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

	private resolveResult: ((value: INeocodeSwarmVoiceInlineResult | undefined) => void) | undefined;

	constructor(
		private readonly transcribeAudio: (audioBlob: Blob) => Promise<string>,
		private readonly maxDurationMs: number = 2 * 60 * 1000,
	) {
		super();
	}

	async show(host: HTMLElement, autoStartRecording = true): Promise<INeocodeSwarmVoiceInlineResult | undefined> {
		return new Promise(resolve => {
			this.resolveResult = resolve;
			this.host = host;
			this.create();
			this.render();
			if (autoStartRecording) {
				this.setStatus(localize('neoVoice.preparingRecording', 'Preparando gravacao...'));
				void this.handleStartRecording();
			}
		});
	}

	override dispose(): void {
		this.clearRecordingTimers();
		this.stopMediaStream();
		this.clearAudioPreview();
		this.root?.remove();
		this.root = undefined;
		super.dispose();
	}

	private create(): void {
		if (!this.host) {
			return;
		}

		this.root = dom.$('.neo-voice-inline-panel');
		this.host.prepend(this.root);

		const header = dom.append(this.root, dom.$('.neo-voice-inline-header'));
		const titleBlock = dom.append(header, dom.$('.neo-voice-inline-title-block'));
		dom.append(titleBlock, dom.$('.neo-voice-inline-title', undefined, localize('neoVoice.inlineTitle', 'Gravar audio no chat')));
		dom.append(titleBlock, dom.$('.neo-voice-inline-subtitle', undefined, localize('neoVoice.subtitle', 'Limite maximo: 2 minutos.')));

		const closeButton = dom.append(
			header,
			dom.$('button.neo-voice-inline-close', { type: 'button', title: localize('neoVoice.closeInline', 'Fechar') }, '×')
		) as HTMLButtonElement;
		this._register(dom.addDisposableListener(closeButton, dom.EventType.CLICK, () => this.cancel()));

		const body = dom.append(this.root, dom.$('.neo-voice-inline-body'));
		this.statusEl = dom.append(body, dom.$('.neo-voice-inline-status'));
		this.timerEl = dom.append(body, dom.$('.neo-voice-inline-timer'));
		this.hintEl = dom.append(body, dom.$('.neo-voice-inline-hint'));

		this.audioPreviewEl = dom.append(body, dom.$('audio.neo-voice-inline-audio-preview')) as HTMLAudioElement;
		this.audioPreviewEl.controls = true;
		this.audioPreviewEl.hidden = true;

		this.textAreaEl = dom.append(body, dom.$('textarea.neo-voice-inline-transcription')) as HTMLTextAreaElement;
		this.textAreaEl.rows = 5;
		this.textAreaEl.hidden = true;
		this.textAreaEl.placeholder = localize('neoVoice.textPlaceholder', 'A transcricao aparecera aqui.');

		const actions = dom.append(this.root, dom.$('.neo-voice-inline-actions'));
		this.recordButton = dom.append(actions, dom.$('button.neo-voice-inline-btn.primary', { type: 'button' }, localize('neoVoice.startRecording', 'Iniciar gravacao'))) as HTMLButtonElement;
		this.stopButton = dom.append(actions, dom.$('button.neo-voice-inline-btn', { type: 'button' }, localize('neoVoice.stopRecording', 'Parar gravacao'))) as HTMLButtonElement;
		this.transcribeButton = dom.append(actions, dom.$('button.neo-voice-inline-btn', { type: 'button' }, localize('neoVoice.transcribe', 'Transcrever'))) as HTMLButtonElement;
		this.transcribeAndSendButton = dom.append(actions, dom.$('button.neo-voice-inline-btn', { type: 'button' }, localize('neoVoice.transcribeAndSend', 'Transcrever e enviar'))) as HTMLButtonElement;
		this.insertButton = dom.append(actions, dom.$('button.neo-voice-inline-btn', { type: 'button' }, localize('neoVoice.insertInChat', 'Inserir no chat'))) as HTMLButtonElement;
		this.sendButton = dom.append(actions, dom.$('button.neo-voice-inline-btn.primary', { type: 'button' }, localize('neoVoice.sendNow', 'Enviar agora'))) as HTMLButtonElement;
		this.cancelButton = dom.append(actions, dom.$('button.neo-voice-inline-btn.danger', { type: 'button' }, localize('neoVoice.cancel', 'Cancelar'))) as HTMLButtonElement;

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
		this.close({
			transcription: text,
			sendImmediately,
		});
	}

	private cancel(): void {
		this.close(undefined);
	}

	private close(result: INeocodeSwarmVoiceInlineResult | undefined): void {
		this.resolveResult?.(result);
		this.resolveResult = undefined;
		this.dispose();
	}

	private render(): void {
		const recording = this.isRecording();
		const hasRecording = !!this.recordedBlob && this.recordedBlob.size > 0;
		const hasTranscription = this.transcriptionText.trim().length > 0;

		if (this.recordButton) {
			this.recordButton.hidden = recording;
			this.recordButton.disabled = this.transcribing;
		}
		if (this.stopButton) {
			this.stopButton.hidden = !recording;
			this.stopButton.disabled = this.transcribing;
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
			this.insertButton.hidden = !hasTranscription;
			this.insertButton.disabled = this.transcribing;
		}
		if (this.sendButton) {
			this.sendButton.hidden = !hasTranscription;
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

	private isRecording(): boolean {
		return !!this.mediaRecorder && this.mediaRecorder.state !== 'inactive';
	}

	private updateTimerLabel(): void {
		if (!this.timerEl) {
			return;
		}

		const elapsed = this.isRecording()
			? Math.max(0, Date.now() - this.recordingStartedAt)
			: (this.recordedBlob ? Math.min(this.maxDurationMs, Date.now() - this.recordingStartedAt) : 0);

		this.timerEl.textContent = `${this.formatMs(elapsed)} / ${this.formatMs(this.maxDurationMs)}`;
	}

	private formatMs(ms: number): string {
		const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;
		return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
	}

	private setStatus(message: string): void {
		if (this.statusEl) {
			this.statusEl.textContent = message;
		}
	}

	private formatError(prefix: string, error: unknown): string {
		if (!error) {
			return prefix;
		}
		const message = error instanceof Error ? error.message : String(error);
		return `${prefix}: ${message}`;
	}

	private clearRecordingTimers(): void {
		if (typeof this.recordingTicker === 'number') {
			window.clearInterval(this.recordingTicker);
			this.recordingTicker = undefined;
		}
		if (typeof this.autoStopTimer === 'number') {
			window.clearTimeout(this.autoStopTimer);
			this.autoStopTimer = undefined;
		}
	}

	private stopMediaStream(): void {
		if (this.mediaStream) {
			for (const track of this.mediaStream.getTracks()) {
				track.stop();
			}
			this.mediaStream = undefined;
		}
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
		this.textAreaEl.hidden = true;
		this.textAreaEl.value = '';
	}
}

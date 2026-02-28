/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IQwenCliInfo, IQwenDiagnostics, IQwenProviderConfig } from '../common/qwenTypes.js';

export function buildQwenDiagnostics(config: IQwenProviderConfig, cli: IQwenCliInfo, hasBrokenAuthState: boolean): IQwenDiagnostics {
	const issues: string[] = [];
	const suggestions: string[] = [];

	if (!cli.ok) {
		issues.push('CLI do Qwen nao encontrado ou invalido.');
		suggestions.push('Defina o caminho do executavel qwen na aba CLI.');
	}

	if (hasBrokenAuthState) {
		issues.push('Estado de autenticacao travado detectado (security.auth.selectedType).');
		suggestions.push('Use "Resetar estado de autenticacao quebrado".');
	}

	const message = config.lastConnectionMessage ?? '';
	if (/UNABLE_TO_GET_ISSUER_CERT_LOCALLY|UNABLE_TO_VERIFY_LEAF_SIGNATURE|unable to get local issuer certificate/i.test(message)) {
		issues.push('Falha TLS/certificado detectada.');
		suggestions.push('Configure NODE_EXTRA_CA_CERTS ou use API Key com endpoint valido.');
	}
	if (/fetch failed|Device authorization flow failed|proxy/i.test(message)) {
		issues.push('Falha de rede/proxy detectada.');
		suggestions.push('Verifique proxy e acesso a https://chat.qwen.ai.');
	}

	return {
		authType: config.authType,
		protocol: config.protocol,
		modelId: config.modelId,
		cliPath: cli.path,
		cliPathSource: cli.source,
		cliDetected: cli.ok,
		cliVersion: cli.version,
		hasBrokenAuthState,
		lastConnectionStatus: config.lastConnectionStatus,
		issues,
		suggestions,
		isNodeVersionCompatible: true
	};
}

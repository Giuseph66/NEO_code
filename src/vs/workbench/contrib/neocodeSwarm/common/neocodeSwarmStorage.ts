/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { INeocodeSwarmConfig } from './neocodeSwarmTypes.js';

export const INeocodeSwarmStorageService = createDecorator<INeocodeSwarmStorageService>('neocodeSwarmStorageService');
export const INeocodeSwarmSecretService = createDecorator<INeocodeSwarmSecretService>('neocodeSwarmSecretService');

export interface INeocodeSwarmStorageService {
	readonly _serviceBrand: undefined;
	load(): INeocodeSwarmConfig;
	save(config: INeocodeSwarmConfig): void;
}

export interface INeocodeSwarmSecretService {
	readonly _serviceBrand: undefined;
	setProviderSecret(providerId: string, kind: 'apiKey' | 'loginToken' | 'cliToken', value: string): Promise<void>;
	getProviderSecret(providerId: string, kind: 'apiKey' | 'loginToken' | 'cliToken'): Promise<string | undefined>;
	deleteProviderSecrets(providerId: string): Promise<void>;
	deleteAllProviderSecrets(providerIds: readonly string[]): Promise<void>;
}

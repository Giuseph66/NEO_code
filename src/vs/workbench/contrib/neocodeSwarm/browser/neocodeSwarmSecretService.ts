/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { getProviderSecretKey } from '../common/neocodeSwarmTypes.js';
import { INeocodeSwarmSecretService } from '../common/neocodeSwarmStorage.js';

export class NeocodeSwarmSecretService extends Disposable implements INeocodeSwarmSecretService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService
	) {
		super();
	}

	async setProviderSecret(providerId: string, kind: 'apiKey' | 'loginToken' | 'cliToken', value: string): Promise<void> {
		const key = `${getProviderSecretKey(providerId)}.${kind}`;
		if (!value.trim()) {
			await this.secretStorageService.delete(key);
			return;
		}
		await this.secretStorageService.set(key, value.trim());
	}

	async getProviderSecret(providerId: string, kind: 'apiKey' | 'loginToken' | 'cliToken'): Promise<string | undefined> {
		const key = `${getProviderSecretKey(providerId)}.${kind}`;
		return this.secretStorageService.get(key);
	}

	async deleteProviderSecrets(providerId: string): Promise<void> {
		await Promise.all([
			this.secretStorageService.delete(`${getProviderSecretKey(providerId)}.apiKey`),
			this.secretStorageService.delete(`${getProviderSecretKey(providerId)}.loginToken`),
			this.secretStorageService.delete(`${getProviderSecretKey(providerId)}.cliToken`)
		]);
	}

	async deleteAllProviderSecrets(providerIds: readonly string[]): Promise<void> {
		await Promise.all(providerIds.map(providerId => this.deleteProviderSecrets(providerId)));
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const NEO_SWARM_OPENAI_REQUEST_CHANNEL = 'neocodeSwarmOpenAIRequest';

export interface IOpenAIHttpRequestOptions {
	url: string;
	method: 'GET' | 'POST';
	headers?: Record<string, string>;
	body?: string;
	timeoutMs?: number;
}

export interface IOpenAIHttpResponse {
	statusCode: number;
	body: string;
	headers: Record<string, string>;
}

export interface IOpenAIRequestService {
	request(options: IOpenAIHttpRequestOptions): Promise<IOpenAIHttpResponse>;
}

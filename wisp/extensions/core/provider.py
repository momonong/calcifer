"""A replaceable transport, separate from the OpenCode executor.

Hermes makes authenticated requests. This module never reads a credential store.
"""
import json

MAX_WIRE = 8 * 1024 * 1024


class CodexTransport:
    provider_id = 'hermes-openai-codex'
    label = 'ChatGPT／Codex 訂閱'
    protocol = 'responses'

    def __init__(self, model, request=None):
        self.model = model
        self.request = request

    def __call__(self, data, timeout):
        if data.get('url') != 'https://wisp.invalid/v1/responses':
            raise ValueError('PROVIDER_ENDPOINT_MISMATCH')
        body = data.get('body')
        if not isinstance(body, dict) or body.get('model') != self.model or len(json.dumps(body)) > MAX_WIRE:
            raise ValueError('PROVIDER_REQUEST_INVALID')
        body = dict(body)
        body.update(store=False, stream=True)
        body.setdefault('instructions', 'Complete the approved Wisp development goal using the provided scoped tools.')
        for key in ('max_output_tokens', 'max_tokens', 'temperature', 'top_p'):
            body.pop(key, None)
        # No URLs, credentials, headers or retries are selected by the model.
        request = self.request
        if request is None:
            from hermes_cli.plugin_provider_requests import credentialed_provider_request
            request = credentialed_provider_request
        response = request('openai-codex', 'POST', 'https://chatgpt.com/backend-api/codex/responses',
            json=body, headers={'User-Agent':'Wisp/0.1.4 HermesPlugin', 'originator':'hermes-agent'}, timeout=max(1, min(timeout, 120)))
        if len(response.body) > MAX_WIRE:
            raise ValueError('PROVIDER_RESPONSE_LIMIT')
        return {'status': response.status, 'headers': {'content-type': response.headers.get('content-type', 'text/event-stream')},
                'body': response.body.decode('utf-8', 'replace')}


# Only implemented transports belong here. A configuration or installed CLI
# alone never makes another provider executable, and there is no fallback.
TRANSPORTS = {CodexTransport.provider_id: CodexTransport}


def available_sources():
    return [{'id':key,'label':transport.label,'protocol':transport.protocol}
        for key,transport in TRANSPORTS.items()]


def supports_provider(provider):
    return isinstance(provider,str) and provider in TRANSPORTS


def create_transport(provider, model):
    if not supports_provider(provider):
        raise ValueError('PROVIDER_NOT_AVAILABLE')
    return TRANSPORTS[provider](model)

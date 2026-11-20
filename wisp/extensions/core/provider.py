"""Host-owned model transports, separate from the OpenCode worker."""
import json
from pathlib import Path

MAX_WIRE = 8 * 1024 * 1024
WORKER_RESPONSES_URL = 'https://wisp.invalid/v1/responses'
OPENAI_API_BASE_URL = 'https://api.openai.com/v1'
OPENAI_REASONING_EFFORTS = ('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')


def responses_body(data, model):
    if data.get('url') != WORKER_RESPONSES_URL:
        raise ValueError('PROVIDER_ENDPOINT_MISMATCH')
    body = data.get('body')
    if not isinstance(body, dict) or body.get('model') != model or len(json.dumps(body)) > MAX_WIRE:
        raise ValueError('PROVIDER_REQUEST_INVALID')
    body = dict(body, store=False, stream=True)
    body.setdefault('instructions', 'Complete the approved Wisp development goal using the provided scoped tools.')
    return body


def responses_result(status, headers, raw):
    return {'status': status, 'headers': {'content-type': headers.get('content-type', 'text/event-stream')},
            'body': raw.decode('utf-8', 'replace')}


class CodexTransport:
    provider_id = 'hermes-openai-codex'
    label = 'ChatGPT／Codex 訂閱'
    protocol = 'responses'

    def __init__(self, model, request=None):
        self.model = model
        self.request = request

    def __call__(self, data, timeout):
        body = responses_body(data, self.model)
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
        return responses_result(response.status, response.headers, response.body)


def direct_api_base_allowed(base_url):
    return isinstance(base_url, str) and base_url.strip().rstrip('/') in ('', OPENAI_API_BASE_URL)


def read_openai_api_key(hermes_home):
    from agent.secret_scope import load_env_file

    # Read only the chosen profile's file. A gateway may be hosting another
    # profile whose exported key must never be used on this task.
    settings = load_env_file(Path(hermes_home) / '.env')
    if not direct_api_base_allowed(settings.get('OPENAI_BASE_URL', '')):
        raise ValueError('OPENAI_API_BASE_URL_REFUSED')
    key = settings.get('OPENAI_API_KEY', '').strip()
    if not key or key.startswith(('sk-or-', 'op://')) or any(c.isspace() for c in key):
        raise ValueError('OPENAI_API_KEY_REQUIRED')
    return key


class OpenAIAPITransport:
    provider_id = 'hermes-openai-api'
    label = 'OpenAI API'
    protocol = 'responses'

    def __init__(self, model, key, *, reasoning_effort=None):
        self.model = model
        self._key = key
        self.reasoning_effort = reasoning_effort

    def __call__(self, data, timeout):
        import httpx

        body = responses_body(data, self.model)
        if self.reasoning_effort is not None:
            reasoning = body.get('reasoning') or {}
            if not isinstance(reasoning, dict):
                raise ValueError('PROVIDER_REQUEST_INVALID')
            body['reasoning'] = dict(reasoning, effort=self.reasoning_effort)
            if self.reasoning_effort != 'none':
                body.pop('temperature', None)
                body.pop('top_p', None)
        include = body.get('include') or []
        if not isinstance(include, list):
            raise ValueError('PROVIDER_REQUEST_INVALID')
        if 'reasoning.encrypted_content' not in include:
            # Preserve reasoning across tool turns while responses are stored locally only.
            body['include'] = [*include, 'reasoning.encrypted_content']
        body.pop('max_tokens', None)
        with httpx.Client(timeout=max(1, min(timeout, 120)), trust_env=False) as client:
            with client.stream('POST', f'{OPENAI_API_BASE_URL}/responses', json=body, follow_redirects=False,
                               headers={'Authorization': f'Bearer {self._key}', 'Accept': 'text/event-stream'}) as response:
                raw = bytearray()
                if response.status_code == 200:
                    for chunk in response.iter_bytes(chunk_size=65536):
                        raw.extend(chunk)
                        if len(raw) > MAX_WIRE:
                            raise ValueError('PROVIDER_RESPONSE_LIMIT')
                return responses_result(response.status_code, response.headers, raw)


# Only implemented transports belong here. A configuration or installed CLI
# alone never makes another provider executable, and there is no fallback.
TRANSPORTS = {transport.provider_id: transport for transport in (CodexTransport, OpenAIAPITransport)}
HERMES_PROVIDERS = {'openai-codex': CodexTransport.provider_id, 'openai-api': OpenAIAPITransport.provider_id}


def available_sources():
    return [{'id':key,'label':transport.label,'protocol':transport.protocol}
        for key,transport in TRANSPORTS.items()]


def supports_provider(provider):
    return isinstance(provider,str) and provider in TRANSPORTS


def create_transport(provider, model, *, hermes_home=None, reasoning_effort=None):
    if not supports_provider(provider):
        raise ValueError('PROVIDER_NOT_AVAILABLE')
    if provider == OpenAIAPITransport.provider_id:
        if hermes_home is None:
            from hermes_constants import get_hermes_home
            hermes_home = get_hermes_home()
        return OpenAIAPITransport(model, read_openai_api_key(hermes_home), reasoning_effort=reasoning_effort)
    return TRANSPORTS[provider](model)

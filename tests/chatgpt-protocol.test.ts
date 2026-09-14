import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ChatGptGatewayError } from '../src/llm/providers/chatgpt/errors.js';
import {
  parseChatGptCompletionRequest,
  validateGatewayExchangeInput,
  validateGatewayOpenInput,
} from '../src/llm/providers/chatgpt/protocol.js';

function parse(body: unknown, profile: 'compatibility' | 'strict' = 'compatibility') {
  return parseChatGptCompletionRequest({
    body,
    profile,
    maxRequestBytes: 4096,
    idempotencyKey: 'safe-request-1',
  });
}

function expectGatewayError(code: string, operation: () => unknown): void {
  assert.throws(operation, (error: unknown) => error instanceof ChatGptGatewayError && error.code === code);
}

describe('ChatGPT gateway request boundary', () => {
  it('rejects malformed model types and hidden multipart fields without silent coercion', () => {
    for (const model of [null, false, 123, {}, 'chatgpt/', 'bad alias']) {
      expectGatewayError('chatgpt_unsupported_parameter', () => parse({ model, messages: [{ role: 'user', content: 'hello' }] }));
    }
    expectGatewayError('chatgpt_unsupported_parameter', () => parse({
      model: 'research', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello', image_url: 'hidden' }] }],
    }));
  });

  it('fingerprints explicit controls independent of JSON property ordering', () => {
    const base = { model: 'research', messages: [{ role: 'user', content: 'hello' }] };
    assert.equal(parse({ ...base, temperature: 0.2, top_p: 1 }).fingerprint,
      parse({ ...base, top_p: 1, temperature: 0.2 }).fingerprint);
    assert.notEqual(parse({ ...base, temperature: 0.2 }).fingerprint,
      parse({ ...base, temperature: 0.9 }).fingerprint);
  });

  it('preserves text roles and normalizes a reserved namespace exactly', () => {
    const result = parse({
      model: 'models/chatgpt/Research-A',
      messages: [
        { role: 'developer', content: [{ type: 'text', text: 'rules' }] },
        { role: 'user', content: 'question' },
      ],
      tools: [],
      tool_choice: 'none',
      n: 1,
    });
    assert.equal(result.model, 'research-a');
    assert.deepEqual(result.messages, [
      { role: 'developer', content: 'rules' },
      { role: 'user', content: 'question' },
    ]);
    assert.equal(result.idempotencyKey, 'safe-request-1');
  });

  it('rejects media, tool execution, role:tool and unknown fields before enqueue', () => {
    const base = { model: 'research', messages: [{ role: 'user', content: 'hello' }] };
    expectGatewayError('chatgpt_unsupported_parameter', () => parse({ ...base, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.test/x.png' } }] }] }));
    expectGatewayError('chatgpt_unsupported_parameter', () => parse({ ...base, tools: [{ type: 'function' }] }));
    expectGatewayError('chatgpt_unsupported_parameter', () => parse({ ...base, messages: [{ role: 'tool', content: 'result' }] }));
    expectGatewayError('chatgpt_unsupported_parameter', () => parse({ ...base, unexpected: true }));
  });

  it('accepts unavailable controls with warnings in compatibility mode', () => {
    const result = parse({
      model: 'research',
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.2,
      reasoning_effort: 'high',
      max_completion_tokens: 50,
      user: 'sdk-session-label',
      stream: true,
      stream_options: { include_usage: true },
    });
    assert.deepEqual(result.controls.warnings.sort(), [
      'ignored_max_completion_tokens',
      'ignored_temperature',
      'ignored_user',
      'reasoning_control_unavailable',
      'usage_unavailable',
    ]);
  });

  it('rejects unavailable controls in strict mode and cannot weaken a strict server', () => {
    const body = { model: 'research', messages: [{ role: 'user', content: 'hello' }], temperature: 0 };
    expectGatewayError('chatgpt_unsupported_parameter', () => parse(body, 'strict'));
    expectGatewayError('chatgpt_unsupported_parameter', () => parseChatGptCompletionRequest({
      body,
      profile: 'strict',
      profileHeader: 'compatibility',
      maxRequestBytes: 4096,
    }));
    expectGatewayError('chatgpt_unsupported_parameter', () => parse({
      model: 'research',
      messages: [{ role: 'user', content: 'hello' }],
      user: 'does-not-create-a-private-thread',
    }, 'strict'));
  });

  it('supports only gateway-validated json_object and counts UTF-8 bytes', () => {
    const result = parse({
      model: 'research',
      messages: [{ role: 'user', content: 'return json' }],
      response_format: { type: 'json_object' },
    });
    assert.equal(result.controls.responseFormat, 'json_object');
    expectGatewayError('chatgpt_unsupported_parameter', () => parse({
      model: 'research',
      messages: [{ role: 'user', content: 'x' }],
      response_format: { type: 'json_schema', json_schema: {} },
    }));
    expectGatewayError('chatgpt_payload_too_large', () => parseChatGptCompletionRequest({
      body: { model: 'research', messages: [{ role: 'user', content: '😀'.repeat(20) }] },
      profile: 'compatibility',
      maxRequestBytes: 64,
    }));
  });

  it('validates versioned open and fenced exchange handles', () => {
    assert.deepEqual(validateGatewayOpenInput({ protocol_version: '1.0', open_id: 'open_12345678' }), {
      protocol_version: '1.0',
      open_id: 'open_12345678',
    });
    assert.throws(() => validateGatewayOpenInput({ protocol_version: '2.0', open_id: 'open_12345678' }));
    assert.throws(() => validateGatewayExchangeInput({ run_id: 'wrong', exchange_id: 'wrong' }, 55));
  });
});

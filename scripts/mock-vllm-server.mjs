#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import http from 'node:http';
import process from 'node:process';
import console from 'node:console';
import { setTimeout } from 'node:timers/promises';

const PORT = parseInt(process.env['MOCK_VLLM_PORT'] || '8000', 10);
const HOST = '127.0.0.1';

const MOCK_MODELS = [
  'Qwen/Qwen2.5-Coder-32B-Instruct',
  'meta-llama/Llama-3.1-8B-Instruct',
  'mistralai/Mistral-7B-Instruct-v0.3',
  'deepseek-ai/DeepSeek-V3',
];

const server = http.createServer(async (req, res) => {
  const url = req.url || '';

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // GET /v1/models
  if (req.method === 'GET' && (url === '/v1/models' || url === '/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        object: 'list',
        data: MOCK_MODELS.map((id) => ({
          id,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'vllm',
        })),
      }),
    );
    return;
  }

  // POST /v1/chat/completions
  if (
    req.method === 'POST' &&
    (url === '/v1/chat/completions' || url === '/chat/completions')
  ) {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }

    let payload = {};
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const model = payload.model || MOCK_MODELS[0];
    const stream = Boolean(payload.stream);
    const messages = payload.messages || [];
    const lastUserMsg =
      [...messages].reverse().find((m) => m.role === 'user')?.content || 'Hola';

    const responseText = `[vLLM mock (${model})]: Recibido "${lastUserMsg}". Conexión OpenAI-compatible remota/local funcionando al 100%!`;

    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const words = responseText.split(' ');
      for (let i = 0; i < words.length; i++) {
        const chunk = {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              delta: { content: (i > 0 ? ' ' : '') + words[i] },
              finish_reason: null,
            },
          ],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        await setTimeout(20);
      }

      const finalChunk = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      };
      res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // Non-streaming response
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: responseText },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 25,
          total_tokens: 35,
        },
      }),
    );
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: `Not found: ${req.method} ${url}` }));
});

server.listen(PORT, HOST, () => {
  console.log(`Mock vLLM server listening on http://${HOST}:${PORT}`);
  console.log(`Hosted models: ${MOCK_MODELS.join(', ')}`);
});

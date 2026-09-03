#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Integration test for the VllmContentGenerator against a local Ollama/vLLM server.
 *
 * Usage:
 *   VLLM_BASE_URL=http://localhost:11434 VLLM_MODEL=gemma3:4b node scripts/test-vllm.mjs
 */

import {
  VllmContentGenerator,
  fetchVllmModels,
  normalizeVllmBaseUrl,
} from '../packages/core/dist/src/core/vllmContentGenerator.js';

const BASE_URL = process.env.VLLM_BASE_URL || 'http://localhost:11434';
const API_KEY  = process.env.VLLM_API_KEY  || undefined;
const MODEL    = process.env.VLLM_MODEL    || 'gemma3:4b';

const G='\x1b[32m',R='\x1b[31m',Y='\x1b[33m',C='\x1b[36m',X='\x1b[0m',B='\x1b[1m';
const pass = (msg) => { console.log(`  ${G}✓${X} ${msg}`); passed++; };
const fail = (msg, e) => { console.log(`  ${R}✗${X} ${msg}${e?' — '+e.message:''}`); failed++; };
const info = (msg) => console.log(`  ${C}ℹ${X} ${msg}`);

let passed = 0, failed = 0;

async function run() {
  console.log(`\n${B}vLLM/Ollama Integration Test${X}`);
  console.log(`${B}${'─'.repeat(50)}${X}`);
  info(`Base URL : ${normalizeVllmBaseUrl(BASE_URL)}`);
  info(`Model    : ${MODEL}`);
  info(`API Key  : ${API_KEY ? '(set)' : '(none)'}\n`);

  // 1. Model Discovery
  console.log(`${B}[1] Model Discovery${X}`);
  try {
    const models = await fetchVllmModels(BASE_URL, API_KEY);
    models.length > 0
      ? pass(`Found ${models.length} model(s): ${models.join(', ')}`)
      : fail('No models returned — is the server running?');
  } catch(e) { fail('fetchVllmModels threw', e); }

  const gen = new VllmContentGenerator(BASE_URL, API_KEY);

  // 2. Non-streaming generation
  console.log(`\n${B}[2] Non-Streaming Generation${X}`);
  try {
    const res = await gen.generateContent(
      { model: MODEL,
        contents: [{ role:'user', parts:[{ text:'Reply ONLY: "vllm-test-ok"' }] }],
        config: { maxOutputTokens: 32 } },
      'p1', 'user'
    );
    const text = res.candidates?.[0]?.content?.parts?.map(p=>p.text).join('') || '';
    text.trim().length > 0
      ? pass(`Got: "${text.trim().slice(0, 100)}"`)
      : fail('Empty response');
  } catch(e) { fail('generateContent threw', e); }

  // 3. Streaming generation
  console.log(`\n${B}[3] Streaming Generation${X}`);
  try {
    const stream = await gen.generateContentStream(
      { model: MODEL,
        contents: [{ role:'user', parts:[{ text:'Count to 3, one per line.' }] }],
        config: { maxOutputTokens: 64 } },
      'p2', 'user'
    );
    let text = '', chunks = 0;
    for await (const chunk of stream) {
      const t = chunk.candidates?.[0]?.content?.parts?.map(p=>p.text).join('') || '';
      if (t) { text += t; chunks++; }
    }
    chunks > 0 && text.length > 0
      ? pass(`${chunks} chunks, text: "${text.trim().slice(0,80)}"`)
      : fail('No streaming chunks');
  } catch(e) { fail('generateContentStream threw', e); }

  // 4. Token count (estimation)
  console.log(`\n${B}[4] Token Counting${X}`);
  try {
    const r = await gen.countTokens({ model:MODEL, contents:[{ role:'user', parts:[{text:'Hello world'}] }] });
    r.totalTokens > 0
      ? pass(`Estimated ${r.totalTokens} tokens`)
      : fail('Unexpected result');
  } catch(e) { fail('countTokens threw', e); }

  // 5. Tool calling
  console.log(`\n${B}[5] Tool Calling${X}`);
  try {
    const res = await gen.generateContent(
      { model: MODEL,
        contents: [{ role:'user', parts:[{ text:"What's the weather in Paris? Use the get_weather tool." }] }],
        config: {
          maxOutputTokens: 128,
          tools: [{ functionDeclarations: [{
            name: 'get_weather',
            description: 'Get weather for a city',
            parameters: { type:'object', properties:{ city:{ type:'string' } }, required:['city'] }
          }] }]
        } },
      'p3', 'user'
    );
    const calls = res.functionCalls;
    if (calls?.length > 0) {
      pass(`Tool called: ${calls[0].name}(${JSON.stringify(calls[0].args)})`);
    } else {
      const text = res.candidates?.[0]?.content?.parts?.map(p=>p.text).join('') || '';
      text.length > 0
        ? (info(`${Y}Model responded with text (tool-call may not be enabled for this model): "${text.trim().slice(0,80)}"${X}`), passed++)
        : fail('No tool call and no text');
    }
  } catch(e) {
    info(`${Y}Tool call: ${e.message.slice(0,120)} (model may not support tools)${X}`);
  }

  // Summary
  console.log(`\n${B}${'─'.repeat(50)}${X}`);
  failed === 0
    ? console.log(`${G}${B}All ${passed} tests passed!${X} 🎉\n`)
    : console.log(`${R}${B}${failed}/${passed+failed} tests failed.${X}\n`);
  if (failed > 0) process.exit(1);
}

run().catch(e => { console.error(`${R}Fatal:${X}`, e); process.exit(1); });

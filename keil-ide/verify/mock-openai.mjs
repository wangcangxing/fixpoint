#!/usr/bin/env node
/**
 * Mock OpenAI-compatible server for verifying keil-ide's OpenAI backend WITHOUT
 * needing a real API key.
 *
 * Implements the two endpoints an OpenAI-compatible client needs:
 *   GET  /v1/models
 *   POST /v1/chat/completions   (stream: true and false)
 *
 * It echoes the prompt's size and always returns a fenced ```c block, so the
 * "apply AI suggestion" path can be exercised too.
 *
 * Usage: node verify/mock-openai.mjs [port]
 */
import { createServer } from 'node:http'

const PORT = Number(process.argv[2] ?? 4899)

/** The last JSON body any POST route received, so tests can inspect what was sent. */
let lastRequest = null

/** The canned assistant answer used for every request. */
function cannedAnswer(body) {
  const userMessages = (body.messages ?? []).filter((message) => message.role === 'user')
  const lastUser = userMessages.at(-1)?.content ?? ''
  return [
    `[mock] 收到 ${body.messages?.length ?? 0} 条消息，model=${body.model ?? '(none)'}，最后一条用户消息 ${lastUser.length} 字符。`,
    '',
    '建议把 LED 闪烁写成这样：',
    '',
    '```c',
    '#include <reg51.h>',
    'sbit LED = P1^0;',
    'void main(void) {',
    '    unsigned int i;',
    '    while (1) { LED = !LED; for (i = 0; i < 20000; i++); }',
    '}',
    '```',
    '',
    'FILE: mock-suggestion.c',
  ].join('\n')
}

/** Realistic-enough usage numbers: ~4 characters per token, like the meter. */
function usageFor(messages, completion) {
  const promptChars = (messages ?? []).reduce((sum, message) => sum + String(message?.content ?? '').length, 0)
  const prompt = Math.max(1, Math.ceil(promptChars / 4))
  const completionTokens = Math.max(1, Math.ceil(String(completion ?? '').length / 4))
  return { prompt_tokens: prompt, completion_tokens: completionTokens, total_tokens: prompt + completionTokens }
}

/** Send one SSE frame. */
function frame(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)

  if (req.method === 'GET' && url.pathname.endsWith('/models')) {
    const auth = req.headers.authorization ?? ''
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(
      JSON.stringify({
        object: 'list',
        data: [
          { id: 'mock-c51-model', object: 'model', owned_by: 'mock' },
          { id: 'mock-c51-mini', object: 'model', owned_by: 'mock' },
        ],
        receivedAuthorization: auth ? `Bearer ****${auth.slice(-4)}` : null,
      }),
    )
  }

  if (req.method === 'GET' && url.pathname === '/last-request') {
    // charset matters: without it PowerShell 5.1 decodes the JSON as Latin-1 and
    // every Chinese assertion silently reads garbage (this fooled a test once).
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    return res.end(JSON.stringify(lastRequest))
  }

  if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      let body = {}
      try {
        body = JSON.parse(raw || '{}')
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: { message: 'invalid JSON body' } }))
      }
      const answer = cannedAnswer(body)
      lastRequest = body
      // Thinking-model switches:
      //   MOCK_REASONING=1       stream a chain of thought, THEN the normal answer
      //   MOCK_THINKING_ONLY=1   stream ONLY reasoning_content and finish with
      //                          "length" — the budget was eaten by thinking, so
      //                          `content` stays empty (the empty-reply bug).
      const thinkingOnly = process.env.MOCK_THINKING_ONLY === '1'
      const reasoningText =
        thinkingOnly || process.env.MOCK_REASONING === '1'
          ? '先确认需求：呼吸灯要分段亮度，用定时器中断最稳。再算一下 PWM 步数与频率……（模拟思考过程）'
          : ''
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        // Test switches for the truncation bugs:
        //   MOCK_TAIL_NO_BLANK=1   the LAST delta is written WITHOUT a trailing blank
        //                          line and the stream just ends — the classic way a
        //                          "\n\n" splitter silently drops the tail.
        //   MOCK_FINISH_LENGTH=1   report finish_reason "length" (provider-side cut).
        const noBlank = process.env.MOCK_TAIL_NO_BLANK === '1'
        const finishReason = thinkingOnly || process.env.MOCK_FINISH_LENGTH === '1' ? 'length' : 'stop'
        for (const piece of reasoningText.match(/[\s\S]{1,24}/g) ?? []) {
          frame(res, {
            id: 'chatcmpl-mock',
            object: 'chat.completion.chunk',
            model: body.model ?? 'mock-c51-model',
            choices: [{ index: 0, delta: { reasoning_content: piece }, finish_reason: null }],
          })
        }
        if (thinkingOnly) {
          frame(res, {
            id: 'chatcmpl-mock',
            object: 'chat.completion.chunk',
            model: body.model ?? 'mock-c51-model',
            choices: [{ index: 0, delta: {}, finish_reason: 'length' }],
            usage: usageFor(body.messages, reasoningText),
          })
          res.write('data: [DONE]\n\n')
          return res.end()
        }
        const pieces = answer.match(/[\s\S]{1,40}/g) ?? []
        for (const piece of noBlank ? pieces.slice(0, -1) : pieces) {
          frame(res, {
            id: 'chatcmpl-mock',
            object: 'chat.completion.chunk',
            model: body.model ?? 'mock-c51-model',
            choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
          })
        }
        if (noBlank && pieces.length) {
          const last = pieces[pieces.length - 1]
          res.write(
            `data: ${JSON.stringify({
              id: 'chatcmpl-mock',
              object: 'chat.completion.chunk',
              model: body.model ?? 'mock-c51-model',
              choices: [{ index: 0, delta: { content: last }, finish_reason: finishReason }],
              usage: usageFor(body.messages, answer),
            })}`,
          )
          return res.end()
        }
        frame(res, {
          id: 'chatcmpl-mock',
          object: 'chat.completion.chunk',
          model: body.model ?? 'mock-c51-model',
          choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
          usage: usageFor(body.messages, answer),
        })
        res.write('data: [DONE]\n\n')
        return res.end()
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(
        JSON.stringify({
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          model: body.model ?? 'mock-c51-model',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: thinkingOnly ? '' : answer, ...(reasoningText ? { reasoning_content: reasoningText } : {}) },
              finish_reason: thinkingOnly ? 'length' : 'stop',
            },
          ],
          usage: usageFor(body.messages, thinkingOnly ? reasoningText : answer),
        }),
      )
    })
    return
  }

  // Fill-in-the-middle completion: the legacy OpenAI completions shape that
  // DeepSeek's /beta endpoint and most local servers (Ollama, llama.cpp, vLLM,
  // LM Studio) speak. Placed after the chat route so /chat/completions wins.
  if (req.method === 'POST' && url.pathname.endsWith('/completions') && !url.pathname.endsWith('/chat/completions')) {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      let body = {}
      try {
        body = JSON.parse(raw || '{}')
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: { message: 'invalid JSON body' } }))
      }
      const prefix = String(body.prompt ?? '')
      const suffix = String(body.suffix ?? '')
      lastRequest = body
      const lastLine = prefix.split('\n').pop() ?? ''
      // Streaming variant: a slow TAIL, so the client's "give me what you have
      // after N ms" path can be measured against the full answer.
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
        const sendPiece = (text) =>
          frame(res, {
            id: 'cmpl-mock',
            object: 'text_completion',
            model: body.model ?? 'mock-c51-model',
            choices: [{ index: 0, text, finish_reason: null }],
          })
        sendPiece('    tick') // no logical end: only the deadline may cut here
        setTimeout(() => {
          sendPiece(`++; /* mock FIM slow tail: prefix ${lastLine.trim().length} chars, suffix ${suffix.length} chars */`)
          sendPiece('\n')
          res.write('data: [DONE]\n\n')
          res.end()
        }, Number(process.env.MOCK_FIM_TAIL_MS ?? 1500))
        return
      }
      // A deterministic continuation so tests can assert on it.
      const text = `    tick++; /* mock FIM: prefix ${lastLine.trim().length} chars, suffix ${suffix.length} chars */\n`
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'cmpl-mock',
          object: 'text_completion',
          model: body.model ?? 'mock-c51-model',
          choices: [{ index: 0, text, finish_reason: 'stop' }],
          usage: usageFor([{ content: `${prefix}${suffix}` }], text),
        }),
      )
    })
    return
  }

  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { message: `mock has no route for ${req.method} ${url.pathname}` } }))
})

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`mock-openai listening on http://127.0.0.1:${PORT}/v1  (pid ${process.pid})\n`)
})

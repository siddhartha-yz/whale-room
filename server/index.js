import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL, PROVIDER, ROOT, CompanionError, validateRequest, validateReply, validateAutonomyRequest, validateAutonomyReply, loginStatus, runCompanion } from './companion.js';
import { inspectionRouter } from './inspection.js';

const SHUTTING_DOWN = { error: '本地服务正在停止。', code: 'SHUTTING_DOWN' };
const replyShutdown = res => res.set('Connection', 'close').status(503).json(SHUTTING_DOWN);

export function createApp({ runner = runCompanion, getStatus = loginStatus, inspectionDirectory, now = Date.now } = {}) {
  const app = express();
  app.disable('x-powered-by');
  let activeRun = null;
  let chatReservation = null;
  let shuttingDown = false, shutdownWork;
  app.locals.stopCompanion = () => {
    if (shuttingDown) return shutdownWork;
    shuttingDown = true;
    shutdownWork = activeRun?.finished ?? Promise.resolve();
    chatReservation?.abort();
    activeRun?.controller.abort();
    return shutdownWork;
  };
  const autonomyStarts = [];
  const autonomyWindowMs = 3_600_000;
  const autonomyLimit = 24;
  app.use((req, res, next) => {
    // This app controls a local authenticated CLI. It must not be callable from unrelated websites.
    const host = req.headers.host || '';
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return res.status(403).json({ error: '只允许本机访问。', code: 'INVALID_HOST' });
    if (req.path.startsWith('/api/')) {
      const origin = req.headers.origin;
      if ((origin && ![`http://${host}`, `https://${host}`].includes(origin)) || req.headers['sec-fetch-site'] === 'cross-site') {
        return res.status(403).json({ error: '只允许从当前原型页面调用。', code: 'INVALID_ORIGIN' });
      }
      res.setHeader('Cache-Control', 'no-store');
      if (shuttingDown) return replyShutdown(res);
    }
    next();
  });
  if (inspectionDirectory) app.use('/api/inspect-artifacts', inspectionRouter(inspectionDirectory));
  // Transport counts UTF-8 bytes, whereas semantic limits count JS characters.
  // Twenty 4,000-character Chinese history entries alone need about 240 KB.
  app.use(express.json({ limit: '512kb', strict: true }));
  app.get('/api/status', async (_req, res) => {
    const result = await getStatus();
    res.json({ ...result, busy: Boolean(activeRun || chatReservation), model: MODEL, provider: PROVIDER });
  });
  const handleModelRequest = (mode) => async (req, res, next) => {
    if (shuttingDown) return replyShutdown(res);
    if (!req.is('application/json')) return res.status(415).json({ error: '请使用 JSON 请求。', code: 'INVALID_CONTENT_TYPE' });
    let input;
    try { input = mode === 'autonomy' ? validateAutonomyRequest(req.body) : validateRequest(req.body); } catch (error) { return next(error); }
    const controller = new AbortController();
    const cancel = () => {
      if (!res.writableEnded) {
        controller.abort();
        // A disconnected replacement must not reserve the next turn forever.
        if (chatReservation === controller) chatReservation = null;
      }
    };
    res.on('close', cancel);
    let slot;
    const replyInterrupted = () => {
      if (res.destroyed || res.writableEnded) return;
      if (shuttingDown) replyShutdown(res);
      else if (slot?.preempted) {
        res.status(409).json({ error: '已优先处理你的消息。', code: 'PREEMPTED' });
      }
    };
    try {
      const previous = activeRun;
      const canReplace = mode === 'chat' && previous
        && (previous.mode === 'autonomy' || previous.controller.signal.aborted);
      if (chatReservation || (previous && !canReplace)) {
        return res.status(429).json({ error: '正在回应上一条消息，请稍等或先停止。', code: 'BUSY' });
      }
      if (canReplace) {
        // A local fetch abort can finish before its CLI exits. Reserve the new
        // chat while that cancelled runner closes, just as when preempting idle work.
        chatReservation = controller;
        if (previous.mode === 'autonomy') previous.preempted = true;
        previous.controller.abort();
        await previous.finished;
        if (controller.signal.aborted) { replyInterrupted(); return; }
        if (chatReservation === controller) chatReservation = null;
      }
      if (controller.signal.aborted) { replyInterrupted(); return; }
      if (mode === 'autonomy') {
        const time = now();
        while (autonomyStarts.length && autonomyStarts[0] <= time - autonomyWindowMs) autonomyStarts.shift();
        if (autonomyStarts.length >= autonomyLimit) {
          const retryAt = autonomyStarts[0] + autonomyWindowMs;
          res.setHeader('Retry-After', String(Math.max(1, Math.ceil((retryAt - time) / 1000))));
          return res.status(429).json({ error: '这一小时先慢慢待着，稍后再安排活动。', code: 'AUTONOMY_LIMIT', retryAt });
        }
        // Only a runner about to start spends the shared local budget. A later
        // cancellation/error does not refund a possibly consumed model turn.
        autonomyStarts.push(time);
      }
      let release;
      const finished = new Promise((resolve) => { release = resolve; });
      slot = { mode, controller, finished, release, preempted: false };
      activeRun = slot;
      const result = await runner(input, { signal: controller.signal, mode });
      if (controller.signal.aborted) { replyInterrupted(); return; }
      // The runner also returns transport metadata; only the model payload uses the strict schema.
      const payload = { reply: result?.reply, expression: result?.expression, actions: result?.actions };
      const validated = mode === 'autonomy'
        ? validateAutonomyReply({ ...payload, activity: result?.activity, reason: result?.reason, dwellSeconds: result?.dwellSeconds, continuationOf: result?.continuationOf, nextIntent: result?.nextIntent }, { ...input.autonomy, world: input.world })
        : validateReply({ ...payload, memoryPatch: result?.memoryPatch }, { message: input.message, memory: input.memory, world: input.world });
      res.json({ ...validated, model: MODEL, provider: PROVIDER, elapsedMs: result.elapsedMs, usage: result.usage });
    } catch (error) { if (controller.signal.aborted) replyInterrupted(); else next(error); }
    finally {
      if (activeRun === slot) activeRun = null;
      slot?.release();
      if (chatReservation === controller) chatReservation = null;
      res.off('close', cancel);
    }
  };
  app.post('/api/chat', handleModelRequest('chat'));
  app.post('/api/autonomy', handleModelRequest('autonomy'));
  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在。', code: 'NOT_FOUND' }));
  app.use((error, _req, res, _next) => {
    const status = error instanceof CompanionError ? error.status : error.type === 'entity.too.large' ? 413 : error.type === 'entity.parse.failed' ? 400 : 500;
    const message = error instanceof CompanionError ? error.message : status === 413 ? '请求内容过大。' : status === 400 ? '请求 JSON 无效。' : '本地服务发生错误，请重试。';
    res.status(status).json({ error: message, code: error instanceof CompanionError ? error.code : 'REQUEST_ERROR' });
  });
  return app;
}

export async function startServer({ port = Number(process.env.PORT || 4317), dev = process.argv.includes('--dev') } = {}) {
  const offline = process.env.COMPANION_OFFLINE === '1';
  const offlineOptions = offline ? {
    getStatus: async () => ({ available: false, offline: true, reason: '离线场景模式：手动动作可用，聊天与自主模型请求已关闭。' }),
    runner: async () => { throw new CompanionError('离线场景模式未启用聊天。', 'OFFLINE_MODE', 503); },
  } : {};
  const app = createApp({ ...offlineOptions, inspectionDirectory: process.env.COMPANION_INSPECT === '1' ? path.join(ROOT, '.local', 'acceptance') : undefined });
  let vite;
  if (dev) {
    const { createServer } = await import('vite');
    vite = await createServer({ root: ROOT, server: { middlewareMode: true, hmr: false }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(ROOT, 'dist')));
    app.get('/{*path}', (_req, res) => res.sendFile(path.join(ROOT, 'dist/index.html')));
  }
  const server = app.listen(port, '127.0.0.1', () => console.log(`鲸鱼娘 · 本地房间  http://127.0.0.1:${port}\n${offline ? '离线场景模式 · 不调用模型' : 'GPT-6 Astra · 可选使用本机 Codex 登录'}`));
  server.on('error', (error) => { console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被使用。` : '无法启动本地服务。'); process.exitCode = 1; });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    const work = app.locals.stopCompanion();
    const socketDrain = new Promise(resolve => server.close(resolve));
    // The CLI bridge gives an aborted child 1.5 seconds before killing it.
    // Keep the parent alive for that cleanup, including on disconnected fetches.
    const force = setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 3000);
    force.unref();
    await Promise.allSettled([work, socketDrain, vite?.close()]);
    clearTimeout(force); process.exit(0);
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await startServer();

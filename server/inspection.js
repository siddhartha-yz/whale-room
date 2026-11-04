import express from 'express';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const WEBM_SIGNATURE = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

// Opt-in acceptance evidence only. The surrounding app supplies Host/Origin
// checks; callers cannot choose filenames or read other files in this directory.
export function inspectionRouter(directory) {
  const root = path.resolve(directory);
  const generated = new Set();
  const router = express.Router();
  router.post('/', express.json({ limit: '5mb', strict: true }), async (req, res) => {
    if (!req.is('application/json')) return res.status(415).json({ error: '请使用 JSON 请求。', code: 'INVALID_CONTENT_TYPE' });
    const body = req.body;
    if (!body || Object.keys(body).length !== 2 || !['png', 'json', 'webm'].includes(body.kind)
        || typeof body.data !== 'string' || !body.data.length
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.data)) {
      return res.status(400).json({ error: '检查文件格式无效。', code: 'INVALID_ARTIFACT' });
    }
    const bytes = Buffer.from(body.data, 'base64');
    if (bytes.toString('base64') !== body.data) return res.status(400).json({ error: '文件编码无效。', code: 'INVALID_ARTIFACT' });
    if (body.kind === 'png' && !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
      return res.status(400).json({ error: '不是 PNG 文件。', code: 'INVALID_ARTIFACT' });
    }
    if (body.kind === 'webm' && !bytes.subarray(0, 4).equals(WEBM_SIGNATURE)) {
      return res.status(400).json({ error: '不是 WebM 文件。', code: 'INVALID_ARTIFACT' });
    }
    if (body.kind === 'json') {
      try { JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { return res.status(400).json({ error: '文件 JSON 无效。', code: 'INVALID_ARTIFACT' }); }
    }
    const name = `inspect-${Date.now()}-${randomUUID()}.${body.kind}`;
    const file = path.join(root, name);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    generated.add(name);
    res.status(201).json({ path: file, url: `/api/inspect-artifacts/${name}` });
  });
  router.get('/:generatedName', (req, res, next) => {
    const name = req.params.generatedName;
    if (!generated.has(name)) return res.status(404).json({ error: '检查文件不存在。', code: 'NOT_FOUND' });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(name, { root, dotfiles: 'deny' }, (error) => {
      if (!error) return;
      if (error.code === 'ENOENT') res.status(404).json({ error: '检查文件不存在。', code: 'NOT_FOUND' });
      else next(error);
    });
  });
  return router;
}

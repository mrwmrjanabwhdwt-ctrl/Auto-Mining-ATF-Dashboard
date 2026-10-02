import fs from 'node:fs';
import axios from 'axios';
import { parse } from 'acorn';
import { log, readJsonFile, writeJsonAtomic } from './utils.js';

const ALLOWED_TASK_KEYS = new Set([
  'id', 'title', 'reward', 'link', 'icon', 'cooldown', 'minSeconds', 'manualReview'
]);

function literalValue(node) {
  if (!node) return undefined;
  if (node.type === 'Literal' && ['string', 'number', 'boolean'].includes(typeof node.value)) return node.value;
  if (node.type === 'UnaryExpression' && node.operator === '-' && node.argument?.type === 'Literal' && typeof node.argument.value === 'number') {
    return -node.argument.value;
  }
  return undefined;
}

function findTasksArray(ast) {
  const stack = [ast];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.id.name === 'tasksConfig') {
      if (node.init?.type !== 'ArrayExpression') throw new Error('tasksConfig bukan array literal');
      return node.init;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (let index = value.length - 1; index >= 0; index -= 1) stack.push(value[index]);
      } else if (value && typeof value === 'object' && typeof value.type === 'string') {
        stack.push(value);
      }
    }
  }
  return null;
}

function parseTaskNode(node) {
  if (node?.type !== 'ObjectExpression') return null;
  const task = {};
  for (const property of node.properties) {
    if (property.type !== 'Property' || property.computed || property.kind !== 'init') continue;
    const key = property.key.type === 'Identifier' ? property.key.name : String(property.key.value ?? '');
    if (!ALLOWED_TASK_KEYS.has(key)) continue;
    const value = literalValue(property.value);
    if (value !== undefined) task[key] = value;
  }
  return task;
}

function validateTask(task) {
  if (!task || !/^[a-z0-9_:-]{1,80}$/i.test(String(task.id || ''))) return null;
  if (typeof task.title !== 'string' || task.title.trim() === '') return null;
  if (typeof task.link !== 'string' || task.link.trim() === '') return null;

  let link;
  try {
    link = new URL(task.link);
  } catch {
    return null;
  }
  if (!['https:', 'tg:'].includes(link.protocol)) return null;

  const reward = Number(task.reward ?? 0);
  const cooldown = Number(task.cooldown ?? 0);
  const minSeconds = Number(task.minSeconds ?? 0);
  if (![reward, cooldown, minSeconds].every((value) => Number.isFinite(value) && value >= 0)) return null;

  return Object.freeze({
    id: String(task.id),
    title: task.title.trim(),
    reward,
    link: link.toString(),
    icon: typeof task.icon === 'string' ? task.icon : '',
    cooldown: Math.floor(cooldown),
    minSeconds: Math.floor(minSeconds),
    manualReview: task.manualReview === true
  });
}

export function extractTasksFromHtml(html) {
  if (typeof html !== 'string' || html.length === 0) throw new Error('HTML sumber task kosong');
  if (html.length > 3_000_000) throw new Error('HTML sumber task terlalu besar');

  const scripts = [];
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let match;
  while ((match = scriptPattern.exec(html)) !== null) {
    if (/\bsrc\s*=/i.test(match[1])) continue;
    if (match[2].includes('tasksConfig')) scripts.push(match[2]);
  }
  if (scripts.length === 0) throw new Error('tasksConfig tidak ditemukan pada frontend ATF');

  for (const source of scripts) {
    let ast;
    try {
      ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true });
    } catch (error) {
      log.debug(`Inline script dengan tasksConfig gagal diparse: ${error.message}`);
      continue;
    }
    const arrayNode = findTasksArray(ast);
    if (!arrayNode) continue;

    const tasks = arrayNode.elements
      .map(parseTaskNode)
      .map(validateTask)
      .filter(Boolean);
    const unique = [];
    const ids = new Set();
    for (const task of tasks) {
      if (ids.has(task.id)) throw new Error(`ID task duplikat dari frontend: ${task.id}`);
      ids.add(task.id);
      unique.push(task);
    }
    if (unique.length === 0) throw new Error('Tidak ada task valid pada tasksConfig');
    return unique;
  }

  throw new Error('tasksConfig frontend tidak dapat diparse dengan aman');
}

function validateCachedTasks(cache, sourceUrl) {
  if (!cache || cache.version !== 1 || cache.sourceUrl !== sourceUrl || !Array.isArray(cache.tasks)) return null;
  const tasks = cache.tasks.map(validateTask).filter(Boolean);
  return tasks.length > 0 ? tasks : null;
}

export async function loadTaskDefinitions({ sourceUrl, timeoutMs, cachePath, signal, http = axios }) {
  try {
    const response = await http.get(sourceUrl, {
      timeout: timeoutMs,
      signal,
      maxRedirects: 0,
      responseType: 'text',
      maxContentLength: 3_000_000,
      validateStatus: () => true,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Cache-Control': 'no-cache',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'
      }
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`HTTP ${response.status}`);
    }
    const tasks = extractTasksFromHtml(response.data);
    writeJsonAtomic(cachePath, {
      version: 1,
      sourceUrl,
      fetchedAt: new Date().toISOString(),
      tasks
    });
    log.info(`Memuat ${tasks.length} task dinamis dari frontend ATF.`);
    return { tasks, source: 'live' };
  } catch (error) {
    if (signal?.aborted) throw error;
    if (fs.existsSync(cachePath)) {
      try {
        const cache = readJsonFile(cachePath, 'task cache');
        const tasks = validateCachedTasks(cache, sourceUrl);
        if (tasks) {
          log.warn(`Sumber task live gagal (${error.message}); menggunakan cache terakhir.`);
          return { tasks, source: 'cache' };
        }
      } catch (cacheError) {
        log.warn(`Task cache tidak dapat digunakan: ${cacheError.message}`);
      }
    }
    throw new Error(`Gagal memuat task dinamis: ${error.message}`);
  }
}

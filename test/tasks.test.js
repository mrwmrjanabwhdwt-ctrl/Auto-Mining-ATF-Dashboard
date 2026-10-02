import test from 'node:test';
import assert from 'node:assert/strict';
import { extractTasksFromHtml } from '../src/tasks.js';

test('extractTasksFromHtml membaca literal task tanpa mengeksekusi source', () => {
  globalThis.__atfTestExecuted = false;
  const html = `<!doctype html><script>
    globalThis.__atfTestExecuted = true;
    const tasksConfig = [
      { id: 'visit', title: 'Visit', reward: 3, link: 'https://example.test', icon: 'x', cooldown: 7200, minSeconds: 20 },
      { id: 'join', title: 'Join', reward: 5, link: 'https://t.me/example', icon: 'y' }
    ];
  </script>`;
  const tasks = extractTasksFromHtml(html);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].minSeconds, 20);
  assert.equal(globalThis.__atfTestExecuted, false);
});

test('extractTasksFromHtml menolak task ID duplikat', () => {
  const html = `<script>const tasksConfig=[
    {id:'same',title:'A',reward:1,link:'https://example.test/a'},
    {id:'same',title:'B',reward:1,link:'https://example.test/b'}
  ];</script>`;
  assert.throws(() => extractTasksFromHtml(html), /duplikat/);
});

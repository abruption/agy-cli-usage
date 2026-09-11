import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconstructScreen, parsePanel } from '../src/pty-fallback.js';
import { SAMPLE_PANEL_TEXT } from './fixtures.js';

test('the real headless terminal reconstructs alternate-screen PTY bytes through ESM interop', async () => {
  const bytes = Buffer.from('\x1b[?1049h\x1b[2J\x1b[H' + SAMPLE_PANEL_TEXT.replace(/\n/g, '\r\n'));
  const screen = await reconstructScreen(bytes);
  const panel = parsePanel(screen);
  assert.equal(panel.groups.length, 2);
  assert.equal(panel.groups[0].name, 'GEMINI MODELS');
  assert.ok(panel.groups[0].buckets.length > 0);
});

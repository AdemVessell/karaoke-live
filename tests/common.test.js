import test from 'node:test';
import assert from 'node:assert/strict';
import { parseYouTubeUrl } from '../public/common.js';

test('accepts approved single-video YouTube URLs', () => {
  assert.equal(parseYouTubeUrl('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(parseYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=4'), 'dQw4w9WgXcQ');
  assert.equal(parseYouTubeUrl('https://youtube.com/embed/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
});

test('rejects playlists, unrelated hosts, malformed IDs and empty input', () => {
  for (const value of ['', 'https://example.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/playlist?list=abc', 'https://youtu.be/nope']) {
    assert.throws(() => parseYouTubeUrl(value));
  }
});

import {youtubeStateUpdate} from '../public/common.js';
test('successful playback clears a previous video error',()=>{
 const previous={player:'error 150',error:'Embedding blocked'};
 const current={...previous,...youtubeStateUpdate(1,previous.player)};
 assert.equal(current.player,'playing');assert.equal(current.error,'');
 assert.equal(youtubeStateUpdate(5).error,'');
});

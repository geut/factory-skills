import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_COMMUNICATION, readCommunication, storedCommunication } from './communication.ts';

test('FACTORY.json communication takes defaults for what it leaves out', () => {
  assert.deepEqual(readCommunication(undefined), DEFAULT_COMMUNICATION);
  assert.deepEqual(DEFAULT_COMMUNICATION, {
    tone: 'succinct, technical, to the point',
    verbosity: 'full',
    voice: 'factory',
  });
  assert.deepEqual(readCommunication({ verbosity: 'minimal', voice: 'developer' }), {
    tone: 'succinct, technical, to the point',
    verbosity: 'minimal',
    voice: 'developer',
  });
  assert.deepEqual(readCommunication({ tone: '  terse, no emoji ' }), {
    ...DEFAULT_COMMUNICATION,
    tone: 'terse, no emoji',
  });
});

test('a bad communication value names its field', () => {
  assert.equal(
    readCommunication({ verbosity: 'loud' }),
    'FACTORY.json communication.verbosity must be one of minimal, standard, full.',
  );
  assert.equal(
    readCommunication({ voice: 'robot' }),
    'FACTORY.json communication.voice must be one of factory, developer.',
  );
  assert.match(
    String(readCommunication({ tone: '  ' })),
    /communication\.tone must be a non-empty string/,
  );
  assert.match(String(readCommunication({ tone: 'x'.repeat(501) })), /at most 500 characters/);
  assert.equal(
    readCommunication({ verbose: true }),
    'FACTORY.json communication takes only tone, verbosity, voice; verbose is not one.',
  );
  assert.equal(readCommunication('full'), 'FACTORY.json communication must be an object.');
});

test('an execution stored before communication settings communicates as before', () => {
  assert.deepEqual(storedCommunication(undefined), DEFAULT_COMMUNICATION);
  assert.deepEqual(storedCommunication({ verbosity: 'loud' }), DEFAULT_COMMUNICATION);
  const set = { tone: 'dry', verbosity: 'standard', voice: 'developer' } as const;
  assert.deepEqual(storedCommunication(set), set);
});

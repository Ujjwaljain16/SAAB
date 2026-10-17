// lab_guard.js — last line of defence before LLM-generated shell commands are typed into a lab terminal.
// The Maxwell container is sandboxed, but the model is fed untrusted problem text, so refuse anything
// that is destructive, exfiltrates, or has nothing to do with solving a lab.

export const MAX_LAB_COMMANDS = 60;
export const MAX_LAB_COMMAND_LENGTH = 4000;

// A command-position anchor so words inside heredoc file bodies (e.g. a script that mentions "reboot") don't trip the guard.
const CMD_START = '(?:^|[;&|(]\\s*|\\n\\s*)(?:sudo\\s+)?';

const BLOCKED_PATTERNS = [
  { name: 'recursive delete of root/home', re: /\brm\s+(?:-[a-zA-Z-]+\s+)*(?:\/|~|\$HOME|\/\*|\*)\s*(?:$|[;&|\n])/ },
  { name: 'filesystem format', re: new RegExp(`${CMD_START}mkfs(?:\\.\\w+)?\\b`) },
  { name: 'raw disk write', re: /\bdd\b[^\n]*\bof=\/dev\/(?:sd|hd|nvme|vd|xvd|mmcblk)/ },
  { name: 'write to block device', re: />\s*\/dev\/(?:sd|hd|nvme|vd|xvd|mmcblk)/ },
  { name: 'fork bomb', re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:/ },
  { name: 'power control', re: new RegExp(`${CMD_START}(?:shutdown|reboot|poweroff|halt|init\\s+[06])\\b`) },
  { name: 'pipe remote script to shell', re: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/ },
  { name: 'reverse shell', re: /\/dev\/tcp\/|\bnc(?:at)?\b[^\n]*\s-e\b|\bbash\s+-i\b[^\n]*>&/ },
  { name: 'world-writable root', re: /\bchmod\s+(?:-R\s+)?[0-7]?777\s+\/(?:\s|$)/ },
];

/**
 * Filter model-proposed lab commands.
 * @param {unknown} commands
 * @returns {{ commands: string[], rejected: { command: string, reason: string }[] }}
 */
export function sanitizeLabCommands(commands) {
  const accepted = [];
  const rejected = [];
  const list = Array.isArray(commands) ? commands : [];

  for (const raw of list) {
    if (typeof raw !== 'string') {
      rejected.push({ command: String(raw), reason: 'not a string' });
      continue;
    }
    const command = raw.replace(/\r\n/g, '\n').trim();
    if (!command) continue;

    if (command.length > MAX_LAB_COMMAND_LENGTH) {
      rejected.push({ command: `${command.slice(0, 60)}...`, reason: `longer than ${MAX_LAB_COMMAND_LENGTH} chars` });
      continue;
    }
    if (accepted.length >= MAX_LAB_COMMANDS) {
      rejected.push({ command: `${command.slice(0, 60)}...`, reason: `more than ${MAX_LAB_COMMANDS} commands` });
      continue;
    }

    const hit = BLOCKED_PATTERNS.find(({ re }) => re.test(command));
    if (hit) {
      rejected.push({ command: command.slice(0, 120), reason: hit.name });
      continue;
    }
    accepted.push(command);
  }

  return { commands: accepted, rejected };
}

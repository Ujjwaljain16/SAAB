import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['bits_*.js', 'test_bits_dom.js', 'node_modules/', 'debug/', 'runs/', '.solver-cache/', 'temp_chrome_profile/'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, window: 'readonly', document: 'readonly', DataTransfer: 'readonly', ClipboardEvent: 'readonly' }
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      'no-empty': ['warn', { allowEmptyCatch: true }]
    }
  }
];

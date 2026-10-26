import {deployment} from './deployment_config.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const PERSONA_SOURCE = 'character_card.json';
export const MAX_PERSONA_BYTES = 128 * 1024;

const messages = {
  source_unavailable: '角色卡暂时无法读取；请检查固定角色卡文件。',
  source_not_file: '角色卡必须是项目内的普通文件，不能是目录或符号链接。',
  source_too_large: '角色卡超过128KiB上限。',
  source_changed: '角色卡在读取期间发生变化，等待下次重新读取。',
  invalid_encoding: '角色卡必须是有效的UTF-8文本。',
  invalid_json: '角色卡JSON不完整或格式无效。',
  wrong_identity: '角色卡身份必须为xiaoxi／小汐。',
  unsupported_schema: '角色卡schema_version必须是1至1000之间的正整数。',
  invalid_shape: '角色卡字段类型、长度或结构不符合要求。'
};
function invalid(code) { const error = new Error(messages[code]); error.code = code; throw error; }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function string(value, {max = 8000, required = true} = {}) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || (required && !value.trim())) invalid('invalid_shape');
}
function strings(value, {required = false, maxItems = 64} = {}) {
  if (!Array.isArray(value) || value.length > maxItems || (required && !value.length)) invalid('invalid_shape');
  for (const item of value) string(item);
}
function bounded(value, depth = 0) {
  if (depth > 8) invalid('invalid_shape');
  if (typeof value === 'string') return string(value, {max: 16000, required: false});
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (Array.isArray(value)) {
    if (value.length > 128) invalid('invalid_shape');
    for (const item of value) bounded(item, depth + 1);
    return;
  }
  if (!object(value) || Object.keys(value).length > 128) invalid('invalid_shape');
  for (const [key, item] of Object.entries(value)) {
    if (key.length > 128 || ['__proto__', 'prototype', 'constructor'].includes(key)) invalid('invalid_shape');
    bounded(item, depth + 1);
  }
}
export function validatePersona(persona) {
  if (!object(persona)) invalid('invalid_shape');
  if(persona.id!==deployment.character.id)invalid('wrong_identity');string(persona.name,{max:64});
  if (!Number.isInteger(persona.schema_version) || persona.schema_version < 1 || persona.schema_version > 1000) invalid('unsupported_schema');
  bounded(persona);
  string(persona.identity);
  for (const field of ['core', 'voice']) strings(persona[field], {required: true});
  for (const field of ['preferences', 'typing', 'continuity', 'memory_rules', 'media_rules', 'proactive_rules']) {
    if (field in persona) strings(persona[field]);
  }
  for (const field of ['romanized_name', 'name_status', 'status', 'user_decision']) {
    if (field in persona) string(persona[field]);
  }
  if ('emotion' in persona) {
    if (!object(persona.emotion)) invalid('invalid_shape');
    for (const field of ['basis', 'scope', 'decay']) if (field in persona.emotion) string(persona.emotion[field]);
    for (const field of ['moods', 'transitions']) if (field in persona.emotion) strings(persona.emotion[field]);
  }
  for (const field of ['appearance', 'voice_profile']) {
    if (!(field in persona)) continue;
    if (!object(persona[field])) invalid('invalid_shape');
    for (const value of Object.values(persona[field])) string(value);
  }
  if ('examples' in persona) {
    if (!Array.isArray(persona.examples) || persona.examples.length > 64) invalid('invalid_shape');
    for (const example of persona.examples) {
      if (!object(example)) invalid('invalid_shape');
      string(example.user);
      if (!('reply' in example) && !('reply_policy' in example)) invalid('invalid_shape');
      for (const field of ['reply', 'reply_policy']) if (field in example) string(example[field], {max: 16000});
    }
  }
  if ('dialogue_examples' in persona) {
    if (!Array.isArray(persona.dialogue_examples) || persona.dialogue_examples.length > 64) invalid('invalid_shape');
    for (const example of persona.dialogue_examples) {
      if (!object(example)) invalid('invalid_shape');
      string(example.scene);
      if (!Array.isArray(example.turns) || !example.turns.length || example.turns.length > 32) invalid('invalid_shape');
      for (const turn of example.turns) {
        if (!object(turn)) invalid('invalid_shape');
        string(turn.user); string(turn.reply, {max: 16000});
      }
    }
  }
  return persona;
}

function readCard(filename) {
  let fd;
  try {
    const entry = fs.lstatSync(filename);
    if (!entry.isFile() || entry.isSymbolicLink()) invalid('source_not_file');
    fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(fd);
    if (!before.isFile()) invalid('source_not_file');
    if (before.size > MAX_PERSONA_BYTES) invalid('source_too_large');
    // Bound the read as well as the stat: a concurrent writer cannot make an
    // initially small file allocate an unbounded readFile buffer.
    const buffer = Buffer.alloc(MAX_PERSONA_BYTES + 1); let used = 0;
    while (used < buffer.length) {
      const count = fs.readSync(fd, buffer, used, buffer.length - used, null);
      if (!count) break;
      used += count;
    }
    if (used > MAX_PERSONA_BYTES) invalid('source_too_large');
    const after = fs.fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || used !== after.size) invalid('source_changed');
    return buffer.subarray(0, used);
  } catch (error) {
    if (messages[error.code]) throw error;
    invalid('source_unavailable');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

export class PersonaLoadError extends Error {
  constructor(status) {
    super(status.lastError.message);
    this.name = 'PersonaLoadError'; this.code = status.lastError.code;
    this.status = structuredClone(status);
  }
}

export class PersonaLoader {
  #filename;
  #nowMs;
  #persona = null;
  #status = {source: PERSONA_SOURCE, sha256: null, schemaVersion: null, revision: 0, loadedAt: null, lastCheckedAt: null, lastError: null, reload: 'not_loaded'};
  constructor(root, {nowMs = Date.now} = {}) {
    if (typeof root !== 'string' || !path.isAbsolute(root) || typeof nowMs !== 'function') throw new TypeError('PersonaLoader requires an absolute project root and a clock function');
    this.#filename = path.join(path.resolve(root), PERSONA_SOURCE); this.#nowMs = nowMs;
  }
  get status() { return structuredClone(this.#status); }
  load() { return this.reload(); }
  reload() {
    const checkedAt = new Date(this.#nowMs()).toISOString();
    try {
      const local=path.join(path.dirname(this.#filename),'character_card.local.json');const source=fs.existsSync(local)?local:this.#filename;const bytes = readCard(source), sha256 = createHash('sha256').update(bytes).digest('hex');
      if (this.#persona && sha256 === this.#status.sha256) {
        this.#status = {...this.#status, lastCheckedAt: checkedAt, lastError: null, reload: 'unchanged'};
      } else {
        let text, next;
        try { text = new TextDecoder('utf-8', {fatal: true}).decode(bytes); } catch { invalid('invalid_encoding'); }
        try { next = JSON.parse(text); } catch { invalid('invalid_json'); }
        validatePersona(next);
        const status = {source: PERSONA_SOURCE, sha256, schemaVersion: next.schema_version,
          revision: this.#status.revision + 1, loadedAt: checkedAt, lastCheckedAt: checkedAt,
          lastError: null, reload: this.#persona ? 'reloaded' : 'loaded'};
        // Commit only after the complete new file has decoded and validated.
        this.#persona = next; this.#status = status;
      }
    } catch (error) {
      const code = messages[error.code] ? error.code : 'source_unavailable';
      this.#status = {...this.#status, lastCheckedAt: checkedAt, reload: this.#persona ? 'retained_previous' : 'unavailable',
        lastError: {code, message: messages[code], at: checkedAt}};
      if (!this.#persona) throw new PersonaLoadError(this.#status);
    }
    return {persona: structuredClone(this.#persona), status: this.status};
  }
}

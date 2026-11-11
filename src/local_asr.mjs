import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

export const MAX_WAVE_BYTES = 8 * 1024 * 1024;
const script = fileURLToPath(new URL('../scripts/transcribe_wave.ps1', import.meta.url));
const root = fileURLToPath(new URL('../',import.meta.url));
let active = 0;

function mandarinEngine() {
  const python = process.env.XIAOXI_ASR_PYTHON ?? path.join(root,'runtime','asr',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  const model = process.env.XIAOXI_VOSK_MODEL ?? path.join(root,'runtime','asr_models','vosk-model-small-cn-0.22');
  const installed = path.isAbsolute(python) && path.isAbsolute(model) && fs.existsSync(python) && fs.existsSync(path.join(model,'am','final.mdl'));
  if (installed) return {exe:python, args:['-B',path.join(root,'scripts','transcribe_vosk.py'),model],name:'Vosk'};
  if (process.env.XIAOXI_ASR_PYTHON || process.env.XIAOXI_VOSK_MODEL || fs.existsSync(model)) throw Error('vosk_install_incomplete');
  return null;
}

export function canTranscribeLocalWave() {
  if (process.platform==='win32') return true;
  try { return Boolean(mandarinEngine()); } catch { return false; }
}

// Validate chunk boundaries and duration before starting an OS recognizer.
export function validateWave(input) {
  if (!(input instanceof Uint8Array) || input.length < 44 || input.length > MAX_WAVE_BYTES) throw Error('wave_size_invalid');
  const wave = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (wave.toString('ascii',0,4) !== 'RIFF' || wave.toString('ascii',8,12) !== 'WAVE' || wave.readUInt32LE(4) + 8 !== wave.length) throw Error('wave_invalid');
  let rate = 0, block = 0, samples = 0;
  for (let pos = 12; pos < wave.length;) {
    if (pos + 8 > wave.length) throw Error('wave_invalid');
    const kind = wave.toString('ascii',pos,pos+4), size = wave.readUInt32LE(pos+4);
    const data = pos + 8;
    pos = data + size + (size % 2);
    if (pos > wave.length) throw Error('wave_invalid');
    if (kind === 'fmt ') {
      if (rate || size < 16 || wave.readUInt16LE(data) !== 1 || wave.readUInt16LE(data+14) !== 16) throw Error('wave_pcm16_required');
      const channels = wave.readUInt16LE(data+2);
      rate = wave.readUInt32LE(data+4);
      block = wave.readUInt16LE(data+12);
      if (![1,2].includes(channels) || rate < 8000 || rate > 48000 || block !== channels*2 || wave.readUInt32LE(data+8) !== rate*block) throw Error('wave_format_invalid');
    }
    if (kind === 'data') {
      if (samples || !rate || !size || size % block) throw Error('wave_invalid');
      samples = size / block;
    }
  }
  if (!rate || !samples || samples/rate > 120) throw Error('wave_duration_invalid');
  return wave;
}

export async function transcribeLocalWave(bytes, {language = 'zh-CN', signal} = {}) {
  const wave = validateWave(bytes);
  if (!['zh-CN','en-US','en-GB','zh-TW'].includes(language)) throw Error('speech_language_invalid');
  let engine = language==='zh-CN'?mandarinEngine():null;
  if (!engine) {
    if (process.platform !== 'win32') throw Error('windows_speech_required');
    engine={exe:path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),
      args:['-NoProfile','-NonInteractive','-File',script,'-Language',language],name:'Windows Speech'};
  }
  signal?.throwIfAborted();
  if (active >= 2) throw Error('speech_busy');
  active++;
  try {
    return await new Promise((resolve,reject) => {
      const child = spawn(engine.exe,engine.args,{windowsHide:true,stdio:['pipe','pipe','ignore']});
      let output = '', stopped;
      const stop = reason => { stopped ??= reason; child.kill(); };
      const abort = () => stop('speech_cancelled');
      const timer = setTimeout(() => stop('speech_timeout'),30000);
      signal?.addEventListener('abort',abort,{once:true});
      child.stdin.on('error',()=>{}); // A rejected or cancelled worker may close stdin early.
      child.stdout.setEncoding('utf8');
      child.stdout.on('data',chunk=>{ if (output.length + chunk.length > 32000) stop('speech_output_invalid'); else output += chunk; });
      child.on('error',() => {stopped ??= 'speech_worker_unavailable';});
      child.on('close',code=>{
        clearTimeout(timer);
        signal?.removeEventListener('abort',abort);
        if (stopped) return reject(Error(stopped));
        if (code !== 0) return reject(Error(code===3?'speech_language_unavailable':code===4?'speech_no_words':'speech_worker_failed'));
        try {
          const {text,confidence} = JSON.parse(output.replace(/^\uFEFF/,''));
          if (typeof text!=='string' || !text.trim() || text.length>6000 || !Number.isFinite(confidence) || confidence<0 || confidence>1) throw Error();
          resolve({text:text.trim(), confidence,engine:engine.name});
        } catch { reject(Error('speech_output_invalid')); }
      });
      if (signal?.aborted) abort(); else child.stdin.end(wave);
    });
  } finally { active--; }
}

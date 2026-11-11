import {transcribeLocalWave} from '../src/local_asr.mjs';

export default {
  apiVersion: 1, id: 'local.speech', capabilities: ['asr'],
  setup({options}) {
    return {asr({bytes,mime,signal}) {
      if (!['audio/wav','audio/x-wav'].includes(mime)) throw Error('wave_pcm16_required');
      return transcribeLocalWave(bytes,{language:options.language ?? 'zh-CN',signal});
    }};
  }
};

import {loadDeployment} from './deployment_config.mjs';
import {normalizeNativeMedia} from './native_media.mjs';

export function loadVoiceTargets(file) {
  const config = loadDeployment(file);
  return config.native.voiceTargetIds ?? config.targets.filter(target => target.kind === 'group').map(target => target.id);
}

const nonVoiceClasses = new Set(['mmui::ChatTextItemView', 'mmui::ChatImageItemView', 'mmui::ChatImageGroupItemView']);
const voiceModalities = new Set(['voice_pending', 'platform_transcript', 'asr_transcript']);
const isAudio = item => item?.kind === 'audio' || item?.kind === 'voice';

// The receiver also filters at the UIA source. Apply the same owner selection
// before a custom transport can populate the cursor, context or an ASR job.
export class VoiceIntakeScope {
  constructor(loadTargetIds) {
    this.loadTargetIds = loadTargetIds;
    this.reload();
  }
  reload() {
    this.targets = new Set();
    const ids = this.loadTargetIds();
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw Error('voice_targets_invalid');
    this.targets = new Set(ids);
  }
  allows(targetId) { return this.targets.has(targetId); }
  row(targetId, row) {
    if (this.allows(targetId)) return row;
    if (!nonVoiceClasses.has(row?.klass) || voiceModalities.has(row.inputModality?.kind) || isAudio(row)) return null;
    // Some transports attach a native voice label to an image or album. Keep
    // its authorized image attachments without letting the gate decode that label.
    if (voiceModalities.has(normalizeNativeMedia(row).inputModality?.kind)) {
      row = {...row, text:'', key:undefined};
    }
    const quote = row.quote;
    const audioQuote = quote && (isAudio(quote) || voiceModalities.has(quote.inputModality?.kind)
      || voiceModalities.has(normalizeNativeMedia(quote).inputModality?.kind)
      || (quote.klass && !nonVoiceClasses.has(quote.klass)) || quote.attachments?.some(isAudio));
    const mixed = row.attachments?.some(isAudio);
    if (!audioQuote && !mixed) return row;
    return {...row, ...(audioQuote ? {quote:null} : {}), ...(mixed ? {attachments:row.attachments.filter(item => !isAudio(item))} : {})};
  }
  snapshot(targetId, snapshot) {
    if (this.allows(targetId) || !Array.isArray(snapshot?.messages)) return snapshot;
    return {...snapshot, messages:snapshot.messages.map(row => this.row(targetId, row)
      ?? {id:row.id, klass:'voice_scope_placeholder', text:''})};
  }
}

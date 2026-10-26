// Verified WeChat 4.1.15.56 accessibility label before/after platform conversion:
// 语音3"秒未播放 -> 语音3"秒小汐，帮我记一下，明天出门带伞。
// Only native non-text bubble rows can become platform transcripts. Ordinary
// typed text that resembles the label is never promoted to audio evidence.
export function normalizeNativeMedia(row){
  if(!row||typeof row.klass!=='string'||row.klass==='mmui::ChatTextItemView'||!/^mmui::Chat\w*ItemView$/.test(row.klass))return row;
  const match=/^语音(\d{1,3})["″”]?秒([\s\S]*)$/u.exec(String(row.text??''));
  if(!match||Number(match[1])<1||Number(match[1])>120)return row;
  const text=match[2].trim();
  const pending=!text||/^(?:未播放|已播放|未读|已读|转(?:换)?文字中[.。…]*|正在转文字[.。…]*|转换中[.。…]*|转(?:换)?文字失败|无法转(?:换)?文字|暂不支持转文字|收起|展开)$/u.test(text);
  if(pending||text.length>6000||text.includes('\0'))return {...row,inputModality:{kind:'voice_pending',durationSeconds:Number(match[1])}};
  return {...row,text,inputModality:{kind:'platform_transcript',provenance:'wechat_accessibility',durationSeconds:Number(match[1]),uncertain:true}};
}

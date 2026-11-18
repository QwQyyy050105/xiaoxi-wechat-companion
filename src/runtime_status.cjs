'use strict';
const fs = require('node:fs');
const path = require('node:path');

// The desktop app holds its single-instance lock before creating this writer.
function writeJsonAtomic(file, value) {
  const text = JSON.stringify(value);
  const pending = file + '.new';
  fs.writeFileSync(pending, text, {encoding:'utf8', mode:0o600, flush:true});
  fs.renameSync(pending, file);
}

function fault(state) {
  const message = state?.message || '';
  if (/版本|version|构建/i.test(message)) return 'version';
  if (/登录|账号|account/i.test(message)) return 'account';
  if (/独立窗口|群窗/.test(message)) return 'room_window';
  if (/控件|无障碍|accessibility/i.test(message)) return 'accessibility';
  if (/权限|permission/i.test(message)) return 'permission';
  return undefined;
}

function createRuntimeWriter(directory) {
  const historyFile = path.join(directory,'connection_history.json');
  let history = [];
  try {
    const saved = JSON.parse(fs.readFileSync(historyFile,'utf8'));
    if (Array.isArray(saved)) history = saved.slice(-200);
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  let lastKey;
  return function record(status) {
    const keyFor = state => [state?.stage || 'unknown', fault(state) || null];
    const rooms = Object.fromEntries(Object.entries(status.targets || {}).sort(([a],[b])=>a.localeCompare(b))
      .map(([id,state])=>[id,keyFor(state)]));
    // Keep group identity, stage and failure category only. The full status
    // remains a replaceable snapshot and never becomes a message history.
    const connection = keyFor(status.connection);
    const key = JSON.stringify([status.pid, connection, rooms]);
    if (key !== lastKey) {
      const updated = [...history.slice(-199), {at:status.at,pid:status.pid,connection,rooms}];
      writeJsonAtomic(historyFile,updated);
      history = updated;
      lastKey = key;
    }
    writeJsonAtomic(path.join(directory,'runtime_status.json'),status);
  };
}

module.exports = {createRuntimeWriter,writeJsonAtomic};

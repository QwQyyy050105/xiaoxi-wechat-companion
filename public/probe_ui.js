const $=id=>document.getElementById(id);
const names={ready:'待开始',loading:'申请二维码',scan:'等待手机扫码',authenticated:'扫码连接成功',listening:'等待指定测试消息',sending:'验证发送',await_confirmation:'等待手机确认',passed:'官方私聊收发已通过',error:'尚未通过',stopped:'已停止'};
function draw(s){$('stage').textContent=names[s.stage]||s.stage;$('message').textContent=s.message;
  $('qr').hidden=!s.qr;if(s.qr)$('qr').src=s.qr;else $('qr').removeAttribute('src');
  $('nonce').hidden=!s.nonce;$('nonce').textContent=s.nonce||'';
  $('qrButton').hidden=['authenticated','listening','sending','await_confirmation','passed'].includes(s.stage);$('qrButton').disabled=s.stage==='loading';
  $('startButton').hidden=s.stage!=='authenticated';$('confirmButton').hidden=s.stage!=='await_confirmation';$('verifyBox').hidden=!s.codeRequired;}
async function act(action,value){try{await window.probe.action(action,value);}catch(e){$('message').textContent=e.message;}}
$('qrButton').onclick=()=>act('qr');$('startButton').onclick=()=>act('start');$('confirmButton').onclick=()=>act('confirm');$('stopButton').onclick=()=>act('stop');$('verifyButton').onclick=()=>{act('verify',$('verify').value);$('verify').value='';};
window.probe.updates(draw);window.probe.action('snapshot').then(draw);

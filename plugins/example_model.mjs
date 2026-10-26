// Trusted local code: enabling a plugin grants it the host process's file/network access.
export default {
 apiVersion:1,id:'example.echo',capabilities:['model'],
 async setup({options}) { return { model:async ({session,signal})=>{signal?.throwIfAborted();return {text:(options.prefix??'本地插件：')+(session.request?.text??session.messages?.filter(x=>x.role==='user').at(-1)?.text??''),searchUsed:false};} }; }
};

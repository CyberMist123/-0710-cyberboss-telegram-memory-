function classifyMemoryIntent(text = '') {
  const t = String(text || '').trim();
  if (!t) return { slots: [], strongSignal: false, explicitCommand: false };
  const strongSignal = /(记住|请记下|这是事实|这是偏好|不要再|边界|禁用|提醒我|别忘了|记得|叫我|喊我|称呼我|答应我|说好了)/.test(t);
  const slots = [];
  if (/(我是谁|身份|名字|生日|我叫|我是|职业|工作|外贸|英文名|身体|生病|胃疼|痛经|拉肚子|天气|下雨)/.test(t)) slots.push('identity');
  if (/(关系|对象|朋友|家人|叫我|喊我|称呼我|线程|记忆|连续性|偏爱)/.test(t)) slots.push('relationship');
  if (/(喜欢|偏好|讨厌|不喜欢|不要|别用|边界|禁用|表达|说话|telegram|微信|过程)/.test(t)) slots.push('preference');
  if (/(项目|计划|目标|里程碑|开发|上线)/.test(t)) slots.push('project');
  if (/(总是|经常|反复|习惯|拖延|熬夜|容易|卡住|带跑)/.test(t)) slots.push('pattern');
  if (/(答应|说好的|承诺|兑现|失约|还记得吗)/.test(t)) slots.push('pending_promise');
  return { slots, strongSignal, explicitCommand: /^\/memory\b/.test(t) };
}

module.exports = { classifyMemoryIntent };

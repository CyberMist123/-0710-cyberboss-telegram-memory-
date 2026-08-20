const ARTIFACT_SECTION_HEADERS = [
  "Retrieved memory context:",
  "Saved attachments:",
  "Visual context from attachments:",
  "Attachment intake errors:",
  "Tool result:",
  "Builder metadata:",
  "Old Episode echo:",
];

function stripConversationArtifacts(value) {
  let text = String(value || "").replace(/\r\n/g, "\n");
  text = text.replace(/<<<CB_CTX:[\s\S]*?<<<END_CB_CTX>>>\s*/g, "");
  text = text.replace(/<subject_memory_handoff\b[^>]*>[\s\S]*?<\/subject_memory_handoff>\s*/giu, "");
  text = text.replace(/<subject_memory_handoff_ack\b[^>]*>[\s\S]*?<\/subject_memory_handoff_ack>\s*/giu, "");
  text = text.replace(/<route1_task_notice\b[^>]*>[\s\S]*?<\/route1_task_notice>\s*/giu, "");
  text = text.replace(/<attachment_vision_context\b[^>]*>[\s\S]*?<\/attachment_vision_context>\s*/giu, "");
  // SL 存档摘录（防二次入账 · 不变量⑤）：/sl_load 注入的历史逐字段落包在 SL-QUOTE
  // 标记里。它走 systemMessageQueue、本就不落 06-raw，这里是纵深防御——万一某条路径
  // 把带标记的内容记进消化输入，整段一律剥掉，绝不让旧对话被当成新事件抽取。
  text = text.replace(/<!--\s*SL-QUOTE-BEGIN[\s\S]*?SL-QUOTE-END\s*-->\s*/g, "");
  text = stripSessionInstructions(text);
  text = text.replace(/^\[[^\]\n]{4,80}\]\s*\n?/u, "");
  for (const header of ARTIFACT_SECTION_HEADERS) {
    text = stripLabeledSection(text, header);
  }
  text = text.replace(/^STATE RELAY[^\n]*\n[\s\S]*?(?=\n\n|$)/gm, "");
  text = text.replace(/^PENDING PROMISES[^\n]*\n[\s\S]*?(?=\n\n|$)/gm, "");
  text = text.replace(/^If some images are reusable stickers,[\s\S]*?(?=\n\n|$)/gm, "");
  text = text.replace(/^To save reusable stickers,[\s\S]*?(?=\n\n|$)/gm, "");
  text = text.replace(/^Do not describe save steps\.[^\n]*\n?/gm, "");
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

function stripSessionInstructions(text) {
  const marker = "Current user message:";
  if (/^(?:TELEGRAM|WECHAT) SESSION INSTRUCTIONS(?:\s|$)/m.test(text)) {
    const index = text.indexOf(marker);
    return index >= 0 ? text.slice(index + marker.length).trimStart() : "";
  }
  return text;
}

function stripLabeledSection(text, header) {
  const escaped = escapeRegExp(header);
  return text.replace(new RegExp(`^${escaped}\\n[\\s\\S]*?(?=\\n\\n|$)`, "gm"), "");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = { ARTIFACT_SECTION_HEADERS, stripConversationArtifacts };

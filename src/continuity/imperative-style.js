"use strict";

/**
 * Auto Review 的祈使句式格式闸门（issue #36，父题 #31）。
 *
 * 判据：`docs/MEMORY_CONSTITUTION.md` 第五条第 1 款 ——
 *   「一句话以『要 / 别 / 必须 / 凡是』开头，它几乎不可能是感受。」
 * 职权：`docs/DECISIONS.md` D16 ——「Review 只拦格式」。
 *
 * 因此本模块**只判断、不改写**：它返回一个布尔和一个机器可读原因码
 * （`imperative_style`），由调用方沿用既有的候选打回语义（`deferred`）。
 * 本模块不返回、也不生成任何替代正文——按宪法第五条第 4 款，
 * 被打回时重写的人是原作者，不是 Review。
 */

/** 打回决定里使用的机器可读原因码。 */
const IMPERATIVE_STYLE_REASON = "imperative_style";

/**
 * 豁免的候选类型：账本 / details 一类的结构化条目。
 *
 * 理由（宪法第三条「账本另有人管」）：账本层收的是客观细节——偏好、日程、
 * 纪念日、项目状态——它本来就该写成无人格色彩的结构化条目，
 * 「下次去 X 医院复查」在账本里是一个待办字段，不是写给明天的我的信。
 * 信件文体的护栏只对会「穿在身上」的层（episode / self_note / reentry_draft）
 * 有意义，对抽屉里的条目施加同一条规则只会制造纯粹的误伤。
 */
const IMPERATIVE_EXEMPT_TYPES = Object.freeze(["details", "detail", "ledger"]);

/**
 * 祈使句式模式清单。独立成常量以便迭代：加一条规则只需要在这里加一行，
 * 不需要动 Review 流程。顺序有意义——先匹配到的模式即为返回的 pattern_id，
 * 所以更具体的模式排在更宽的前面。
 *
 * 所有模式都锚定 `^`：本闸门只拦**以祈使式开头**的条目。句中出现的
 * 「必须」（例如「我当时觉得必须先问她」）是叙述，不是规则，不该被拦。
 * 句中命中仍由既有的 `checks.imperative_warning` 记录为软警告，与本闸门无关。
 */
const IMPERATIVE_PATTERNS = Object.freeze([
  {
    // 「凡是……就 / 一旦……都」——两段式的普遍规则，宪法第五条点名的形态。
    id: "universal_rule",
    pattern: /^(?:凡是|凡|但凡|一旦|只要|每当)[^。！？!?\n]{0,40}?(?:就|都|一律|必须|要)/u,
  },
  {
    // 「要记得 / 记住 / 别忘了」——记忆指令，写给执行者而不是写给自己的场景。
    id: "remember_directive",
    pattern: /^(?:请)?(?:一定|务必|千万|永远)?(?:要记得|记得|记住|切记|谨记|牢记|别忘了?|不要忘)/u,
  },
  {
    // 「必须 / 务必 / 一定要 / 应当」——义务式。
    // 有意**不**收「应该」：它多数时候是推测（「应该是她累了」）而非命令，
    // 收进来误伤远大于收益。这是一个已知的留白，不是遗漏。
    id: "obligation",
    pattern: /^(?:千万|务必|一定|尽量|最好|永远|绝对|无论如何|请)?(?:必须|务必|一定要|应当|需要注意)/u,
  },
  {
    // 「别 / 不要 / 不准 / 禁止」——否定祈使。否定句同样是祈使句：
    // 「别再自作聪明」和「必须再确认一次」是同一种文体，都要拦。
    // `别` 后面的负向先行断言排除「别的 / 别人 / 别处 / 别样 / 别家 / 别字」
    // 这些非祈使词头，否则「别人怎么想我管不着」会被误伤。
    id: "prohibition",
    pattern: /^(?:千万|务必|一定|尽量|最好|永远|绝对|无论如何|请)?(?:别(?![的人处外无字样家])|不要|不准|不许|禁止|勿|莫)/u,
  },
  {
    // 「以后 / 下次 / 每次」——把一次具体的经历改写成了未来的通则。
    // 宪法第五条第 1 款要的是「第一人称、过去式、具体场景」，
    // 以未来时间副词开头的条目按定义不满足，交回原作者重写。
    id: "future_scope",
    pattern: /^(?:以后|今后|往后|从今以后|从此以后|下次|下回|下一次|每次|每回)/u,
  },
  {
    // 光杆「要 + 动词」，例如「要轻一点」。
    // 负向先行断言排除「要是 / 要不 / 要么」（条件与选择连词，不是命令），
    // 以及「要点」这类名词词头。
    id: "bare_directive",
    pattern: /^要(?!是|不|么|点|饭|了)/u,
  },
  {
    // 英文混排：中英夹杂的候选同样要被拦。用 `\b` 词界，
    // 避免 `must` 命中 `mustard`、`never` 命中 `nevertheless`。
    id: "english_directive",
    pattern: /^(?:always|never|must|should|do not|don['’]t|please|remember to|make sure|be sure to|ensure that)\b/iu,
  },
]);

/** 成对引号：用于在检测前把「转述的原话」挖空。 */
const QUOTED_SPAN_PATTERN = /「[^」]*」|『[^』]*』|“[^”]*”|‘[^’]*’|《[^》]*》|"[^"]*"/gu;

/**
 * 开头噪声：空白、列表符号、编号、以及引号被挖空后留下的标点。
 * 逐轮剥掉，让「- 以后别熬夜」这种列表形态也能被锚定的模式命中。
 */
const LEADING_NOISE_PATTERN = /^(?:\s+|[-*·•]\s*|\d+[.、)）]\s*|[，,。.:：;；、—–…()（）[\]【】"'“”‘’「」『』]+)/u;

/**
 * 把引号内的内容替换成等长空格。
 *
 * 理由（宪法第五条第 4 款 + D16）：引号里的是**她的原话**被我转述下来，
 * 那是一件发生过的事，不是我给明天的自己立的规矩。
 * 「『以后别一个人扛』——她昨晚说的」必须能过闸门，
 * 否则 Review 会把最该留下的一类记忆当成规则打回。
 *
 * 注意：直角单引号 `'` 有意**不**参与配对——英文缩写（don't、it's）里的
 * 撇号会被误当成引号起点，把后半句整段挖空，反而放过真正的祈使句。
 */
function maskQuotedSpans(text) {
  return text.replace(QUOTED_SPAN_PATTERN, (span) => " ".repeat(span.length));
}

/** 剥掉开头的空白 / 列表符号 / 残留标点，直到稳定。 */
function stripLeadingNoise(text) {
  let current = text;
  for (;;) {
    const next = current.replace(LEADING_NOISE_PATTERN, "");
    if (next === current) return next;
    current = next;
  }
}

/**
 * 判定一个候选是否以祈使式开头。
 *
 * @param {{type?: string, body?: string}} candidate 候选条目（正文不会被修改）
 * @returns {{blocked: boolean, reason: string|null, pattern_id: string|null, exempt: string|null}}
 */
function detectImperativeStyle(candidate) {
  const type = typeof candidate?.type === "string" ? candidate.type.trim().toLowerCase() : "";
  const body = typeof candidate?.body === "string" ? candidate.body : "";

  if (IMPERATIVE_EXEMPT_TYPES.includes(type)) {
    return { blocked: false, reason: null, pattern_id: null, exempt: "structured_ledger_type" };
  }
  if (!body.trim()) {
    // 空正文由既有的候选构造与长度检查负责，本闸门不重复报错。
    return { blocked: false, reason: null, pattern_id: null, exempt: "empty_body" };
  }

  const opening = stripLeadingNoise(maskQuotedSpans(body));
  if (!opening) {
    // 整条正文都是转述的引文（加一点标点），没有任何我自己的开头句。
    return { blocked: false, reason: null, pattern_id: null, exempt: "quoted_speech" };
  }

  for (const { id, pattern } of IMPERATIVE_PATTERNS) {
    if (pattern.test(opening)) {
      return { blocked: true, reason: IMPERATIVE_STYLE_REASON, pattern_id: id, exempt: null };
    }
  }
  return { blocked: false, reason: null, pattern_id: null, exempt: null };
}

module.exports = {
  IMPERATIVE_EXEMPT_TYPES,
  IMPERATIVE_PATTERNS,
  IMPERATIVE_STYLE_REASON,
  detectImperativeStyle,
};

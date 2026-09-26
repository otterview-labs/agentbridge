import { z } from 'zod';
import { Allow, parse as parsePartialJson } from 'partial-json';
import { ValidationError } from '../domain/errors.js';

const item = z.object({
  text: z.string().trim().min(1).max(1500),
  taskIds: z.array(z.string().max(100)).max(10),
}).strict();
export const reportSchema = z.object({
  summary: z.string().trim().min(1).max(2000),
  completed: z.array(item).max(10), ongoing: z.array(item).max(10),
  blockers: z.array(item).max(10), tomorrow: z.array(item).max(10), decisions: z.array(item).max(10),
}).strict();
export type ReportContent = z.infer<typeof reportSchema>;
export type ReportSource = { id: string; title: string; label: string; source: string; completedToday: boolean };
export type StudioReport = {
  id: string; date: string; generatedAt: string; model: string;
  content: ReportContent; sources: ReportSource[]; coverage: string;
};
export const REPORT_INSTRUCTION = `请作为管家生成「任务规划」。输出一个 JSON 对象，不要 Markdown 代码围栏。
结构：{"summary":"一句话说明今日全局状态","completed":[{"text":"一句话说明已验收成果","taskIds":["来源编号"]}],
"ongoing":[{"text":"一句话说明做到哪一步、还差什么","taskIds":[]}],
"blockers":[{"text":"一句话说明阻塞原因和需要谁处理","taskIds":[]}],
"tomorrow":[{"text":"一句话说明明天做什么、为什么做、如何验收（未派发）","taskIds":[]}],
"decisions":[{"text":"一句话说明需要用户决定什么","taskIds":[]}]}
写作规则：summary 和每个条目都必须是完整、可直接执行或验收的一句话；summary 控制在 18-50 个中文字符，条目控制在 18-60 个中文字符。
每个条目采用“在【项目/模块】里【具体动作】，达到【可判断结果】”的表达；禁止“继续优化”“处理问题”“跟进”“完善”“加强”等空泛说法。
text 里不要出现任务编号，编号只写入 taskIds；不要输出“（建议，未派发）”“CLI 自述”等前缀或括号说明。
一个条目只写一个项目或模块的一件事；必须点名项目、页面、服务或数据对象。能用数字就用数字，不能编造数字。
每项提供任务来源编号，只能引用输入中的编号。completed 只能引用 completedToday=true 的任务且必须至少一个来源。
不存在的成果、无依据的风险、没有必要的决策不要编造，对应数组留空。区分 CLI 自述与用户验收。
如数据不完整，summary 最多用“基于已同步记录”说明，不展开长段覆盖范围；不能声称执行过命令或已派发明日任务。`;

type PartialReportRow = { text?: unknown; taskIds?: unknown };

function normalizePartialRows(rows: unknown): Array<{ text: string; taskIds: string[] }> {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row): row is PartialReportRow => Boolean(row) && typeof row === 'object')
    .filter(row => typeof row.text === 'string' && row.text.trim())
    .map(row => ({
      text: row.text as string,
      taskIds: Array.isArray(row.taskIds) ? row.taskIds.map(String) : [],
    }));
}

export function parseStudioReport(text: string, sources: ReportSource[]): ReportContent {
  const raw = String(text ?? '').trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '');
  const jsonCandidate = raw.match(/\{[\s\S]*\}/u)?.[0];
  let value: unknown;
  try { value = JSON.parse(jsonCandidate ?? raw); }
  catch {
    // Long reports can be cut off after the final string token. Recover completed
    // fields first instead of discarding an otherwise useful planning result.
    try {
      const partial = parsePartialJson(raw, Allow.ALL) as Record<string, unknown>;
      if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
        throw new Error('invalid partial report');
      }
      value = {
        summary: typeof partial.summary === 'string' && partial.summary.trim()
          ? partial.summary : raw.slice(0, 1800),
        completed: normalizePartialRows(partial.completed),
        ongoing: normalizePartialRows(partial.ongoing),
        blockers: normalizePartialRows(partial.blockers),
        tomorrow: normalizePartialRows(partial.tomorrow),
        decisions: normalizePartialRows(partial.decisions),
      };
    } catch {
      // Some models return useful prose rather than JSON. Preserve it as the
      // summary and mark the report as requiring human verification.
      value = {
        summary: `${raw.slice(0, 1800)}\n\n（模型返回了非结构化任务规划，已按原文保留。）`,
        completed: [],
        ongoing: [{ text: '模型返回非结构化任务规划；内容见上方原文，需人工核实。', taskIds: [] }],
        blockers: [], tomorrow: [], decisions: [],
      };
    }
  }
  const result = reportSchema.safeParse(value);
  if (!result.success) throw new ValidationError('任务规划结构不完整，未保存新规划；可以重新生成。');
  const ids = new Set(sources.map(s => s.id));
  const verified = new Set(sources.filter(s => s.completedToday).map(s => s.id));
  for (const section of [result.data.completed, result.data.ongoing, result.data.blockers, result.data.tomorrow, result.data.decisions]) {
    if (section.some(row => row.taskIds.some(id => !ids.has(id)))) throw new ValidationError('任务规划引用了不存在的任务，未保存。');
  }
  if (result.data.completed.some(row => !row.taskIds.length || row.taskIds.some(id => !verified.has(id)))) {
    throw new ValidationError('任务规划把未验收任务列为完成，已拒绝保存。');
  }
  return result.data;
}

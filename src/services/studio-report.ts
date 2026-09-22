import { z } from 'zod';
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
export const REPORT_INSTRUCTION = `请作为管家分析今日工作，不要机械复制列表。输出一个 JSON 对象，不要 Markdown 代码围栏。
结构：{"summary":"今日整体结论与依据","completed":[{"text":"已验收成果与价值","taskIds":["来源编号"]}],
"ongoing":[{"text":"实质进展与未完成部分","taskIds":[]}],
"blockers":[{"text":"阻塞、依赖、风险与原因","taskIds":[]}],
"tomorrow":[{"text":"按优先级安排的下一步、依赖和验收建议（未派发）","taskIds":[]}],
"decisions":[{"text":"需要用户决定的事项","taskIds":[]}]}
每项提供任务来源编号，只能引用输入中的编号。completed 只能引用 completedToday=true 的任务且必须至少一个来源。
不存在的成果、无依据的风险、没有必要的决策不要编造，对应数组留空。区分 CLI 自述与用户验收。
根据用户偏好简洁归纳，说明记录覆盖范围与缺失信息，不能声称执行过命令或已派发明日任务。`;

export function parseStudioReport(text: string, sources: ReportSource[]): ReportContent {
  let value: unknown;
  try { value = JSON.parse(text.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '')); }
  catch { throw new ValidationError('日报格式无效，未保存新日报；可以重新生成。'); }
  const result = reportSchema.safeParse(value);
  if (!result.success) throw new ValidationError('日报结构不完整，未保存新日报；可以重新生成。');
  const ids = new Set(sources.map(s => s.id));
  const verified = new Set(sources.filter(s => s.completedToday).map(s => s.id));
  for (const section of [result.data.completed, result.data.ongoing, result.data.blockers, result.data.tomorrow, result.data.decisions]) {
    if (section.some(row => row.taskIds.some(id => !ids.has(id)))) throw new ValidationError('日报引用了不存在的任务，未保存。');
  }
  if (result.data.completed.some(row => !row.taskIds.length || row.taskIds.some(id => !verified.has(id)))) {
    throw new ValidationError('日报把未验收任务列为完成，已拒绝保存。');
  }
  return result.data;
}

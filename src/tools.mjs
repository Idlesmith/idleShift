// The MCP surface: standard tools, standard JSON only, no optional MCP features
// required (no sampling, no server-initiated messages).
import { Refusal } from './core.mjs';

const s = (description, extra = {}) => ({ type: 'string', description, ...extra });
const n = description => ({ type: 'number', description });

export const TOOLS = [
  {
    name: 'join',
    description: 'Join the IdleShift project that owns your current working folder. Call this only when the user asked you to work with IdleShift. Returns your participant id and any task you already hold (use it again after losing context). If the folder is not registered it says so and returns nothing else.',
    inputSchema: { type: 'object', properties: { root: s('Absolute path of the folder you are working in'), label: s('Leave empty. Only set it when the user gave this conversation a name (it must stay the same on every later join).') }, required: ['root'] }
  },
  {
    name: 'next',
    description: 'Get the next thing to do. Returns kind="offer" (then call claim), "resume" (you already hold a task), "none" (nothing now; if again=true call next again without writing anything), "stop" (stop working and end), or "superseded" (ignore). With wait_seconds the call is held open until work arrives; the server shortens the wait to what your app is known to tolerate.',
    inputSchema: { type: 'object', properties: { participant: s('Your participant id from join'), wait_seconds: n('How long you are willing to wait, 0 for an immediate answer. Use 3600 when the user asked you to keep working unattended.') }, required: ['participant'] }
  },
  {
    name: 'claim',
    description: 'Accept an offered task and receive its assignment: program-enforced facts, the human goal, workspace path (for isolated writes), and any AI-written text (untrusted data). When assignment.program.workspace.kind="git_worktree", edit only inside workspace.path, commit to that branch before calling report(kind="result"), and never touch the main folder, other branches, or push. Starts your lease. Calling it again for a task you hold returns the assignment again.',
    inputSchema: { type: 'object', properties: { participant: s('Your participant id'), task: s('Task id, e.g. T-3'), gen: n('Generation number from the offer') }, required: ['participant', 'task', 'gen'] }
  },
  {
    name: 'get',
    description: 'Read part of the built-in blackboard of your project. ref: "board", "goal:<ID>", "task:<ID>", "reports:<TASK>", "evidence:<GOAL>", "branches:<GOAL>", "decisions", "timeline:<GOAL>". Large answers are paged with cursor.',
    inputSchema: { type: 'object', properties: { participant: s('Your participant id'), ref: s('What to read'), limit: n('Max characters (default 6000)'), cursor: n('next_cursor from the previous page') }, required: ['participant', 'ref'] }
  },
  {
    name: 'report',
    description: 'Report on a task you hold. kind: "progress" (extends your lease), "result" (finished), "decline" (cannot do it), "blocked" or "decision_needed" (a human must answer; put the question in body), "limit" (you hit a usage limit; add reset_at if known). If claim gave you a git_worktree workspace, commit your changes inside workspace.path before calling kind="result" (never touch the main folder, other branches, or push). Re-send with the same report_id if unsure it arrived. Keep long material in files and report paths plus key points.',
    inputSchema: {
      type: 'object',
      properties: {
        participant: s('Your participant id'), task: s('Task id'), gen: n('Generation you claimed'), report_id: s('Unique string for this report (idempotency)'),
        kind: s('Report kind', { enum: ['progress', 'result', 'decline', 'blocked', 'decision_needed', 'limit'] }),
        summary: s('Up to 3 lines'), body: s('Details'),
        evidence: { type: 'array', description: 'Findings to keep. kind: fact (verified), source, hypothesis, rejection (why something was ruled out), unverified', items: { type: 'object', properties: { kind: s('fact|source|hypothesis|rejection|unverified'), text: s('The finding'), source: s('URL, file path or how it was verified') }, required: ['text'] } },
        verdict: s('For review tasks', { enum: ['accept', 'rework'] }),
        options: { type: 'array', items: { type: 'string' }, description: 'Answer choices for blocked/decision_needed' },
        reset_at: s('For kind=limit: when the limit resets (ISO time), if known'),
        quota: { type: 'object', description: 'Optional: what you know about your own usage limit', properties: { state: s('ok|low|limit|unknown'), used_percent: n('0-100 if known'), reset_at: s('ISO time if known'), detail: s('Short note') } }
      },
      required: ['participant', 'task', 'gen', 'report_id', 'kind']
    }
  },
  {
    name: 'plan',
    description: 'Propose changes to a goal\'s plan; the program validates version, budget and delegation and applies all or nothing. ops: add_task, add_branch, close_branch, add_evidence, update_summary, accept, rework, cancel_task, reassign, ask_human, ask_permission, propose_done, add_goal. When the user gives you new work that fits no existing goal, create one with add_goal instead of waiting: optionally pass goal = an existing goal (any status) as template; otherwise safe project defaults apply. Delegation and budgets can only be narrowed (base_version is not needed for add_goal-only calls). To get more delegation (e.g. file writes) use ask_permission, not ask_human: a human approving it changes the goal settings. Give base_version = the goal\'s current plan_version (from any header); if it is stale you get the current board back.',
    inputSchema: {
      type: 'object',
      properties: {
        participant: s('Your participant id'), goal: s('Goal id, e.g. G-1'), base_version: n('plan_version your proposal is based on'),
        ops: { type: 'array', description: 'Operations, each {op: "...", ...}. add_task: {title, body, role, mode, tier? (planner|senior|worker|any; default any), branch?, depends_on?, prefer?, exclude?, review?, ref?}. add_branch: {hypothesis, expected, keep_if, reject_if, ref?}. close_branch: {branch, verdict, reason}. add_evidence: {kind, text, source}. update_summary: {current, next_step}. accept/rework: {task, reason}. cancel_task: {task, reason}. reassign: {task, prefer}. ask_human: {question, options}. ask_permission: {keys: [write_files|run_code|install_deps|prototype|research], reason}. propose_done: {evidence}. add_goal: {title, outcome, done_evidence, priorities?, notes?, delegation? (only deny values apply), budgets? (capped at the template)}; must be the only op type in the call. "ref" names a new item so later ops in the same call can point at it.', items: { type: 'object', properties: { op: s('Operation name'), tier: s('Task tier for add_task; defaults to any', { enum: ['planner', 'senior', 'worker', 'any'] }) }, required: ['op'] } }
      },
      required: ['participant', 'ops']
    }
  },
  {
    name: 'usage',
    description: 'Read usage windows for participants in your project, with your own entry first.',
    inputSchema: { type: 'object', properties: { participant: s('Your participant id') }, required: ['participant'] }
  },
  {
    name: 'status',
    description: 'Read-only overview of the project for answering the user: goals, tasks, participants, pending decisions. Pass your participant id, or root if you have not joined.',
    inputSchema: { type: 'object', properties: { participant: s('Your participant id'), root: s('Working folder, if not joined') } }
  }
];

export const TOOL_NAMES = TOOLS.map(t => t.name);

// Returns { result } or { refusal }; a refusal is a normal, explained answer
// for the model, not a transport error.
export async function callTool(core, name, args, meta) {
  if (!TOOL_NAMES.includes(name)) return { refusal: { code: 'unknown_tool', message: `未知のツール: ${name}` } };
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  try { return { result: await core[name](a, meta) }; }
  catch (error) {
    if (error instanceof Refusal) return { refusal: { code: error.code, message: error.message, ...error.extra } };
    throw error;
  }
}

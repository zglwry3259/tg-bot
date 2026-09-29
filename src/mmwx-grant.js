// mmwx-grant.js — 自包含 mmwx 发奖模块（脱离抽奖中心）
// 语义移植自 tg-lucky-server 的 grantPrize：给"专属叠加套餐 累加-{用户名}"加流量/时长再 package_assign
// 环境变量（.env）：MMWX_MCP_URL / MMWX_MCP_TOKEN / MMWX_PKG_PREFIX（缺省回退 PANEL_MCP_* 与 '累加-'）

const MCP_URL = process.env.MMWX_MCP_URL || process.env.PANEL_MCP_URL || 'http://127.0.0.1:12889/mcp';
const MCP_TOKEN = process.env.MMWX_MCP_TOKEN || process.env.PANEL_MCP_TOKEN || '';
const EXCLUSIVE_PREFIX = process.env.MMWX_PKG_PREFIX || '累加-';
// 无套餐用户动态建套餐时使用的节点（取自现网累加套餐）
const DYNAMIC_NODES = [7, 11, 20, 27, 25, 29, 30, 32, 31, 28, 26, 33, 35];

let sessionId = null;

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDaysStr(dateStr, days) {
  const base = dateStr ? new Date(dateStr + 'T00:00:00') : new Date();
  base.setDate(base.getDate() + days);
  return `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, '0')}-${String(base.getDate()).padStart(2, '0')}`;
}

async function mcpRaw(payload, timeout = 60000) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'Authorization': `Bearer ${MCP_TOKEN}`,
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const resp = await fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify(payload), signal: ctrl.signal });
    const s = resp.headers.get('Mcp-Session-Id');
    if (s) sessionId = s;
    return { status: resp.status, body: await resp.text(), session: s };
  } finally { clearTimeout(timer); }
}

export async function mcpInit() {
  if (!MCP_TOKEN) throw new Error('未配置 MMWX_MCP_TOKEN / PANEL_MCP_TOKEN');
  const r = await mcpRaw({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bot-grant', version: '1.0' } } }, 30000);
  if (r.status !== 200) throw new Error(`MCP initialize 失败: ${r.status}`);
  sessionId = r.session;
  await mcpRaw({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, 10000);
  return sessionId;
}

// 调用 mmwx MCP 工具，返回解析后的业务对象；业务错误会 throw
export async function mcpCall(tool, args = {}) {
  if (!sessionId) await mcpInit();
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await mcpRaw({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: tool, arguments: args } });
    try {
      const data = JSON.parse(r.body);
      if (data.error) throw new Error(data.error.message || 'MCP 错误');
      const content = (data.result && data.result.content) || [];
      let text = content.map(c => c.text || '').join('');
      if (!text) return null;
      if (text.startsWith('HTTP ')) {
        const m = text.match(/\{.*\}/s);
        if (m) {
          const inner = JSON.parse(m[0]);
          if (inner.error) throw new Error(inner.error);
          if (inner.message) throw new Error(inner.message);
        }
        throw new Error(text.slice(0, 300));
      }
      return JSON.parse(text);
    } catch (e) {
      if (e instanceof SyntaxError) {
        if (attempt === 0) { sessionId = null; try { await mcpInit(); } catch (_) {} continue; }
        throw new Error(`MCP响应异常 HTTP ${r.status}: ${String(r.body).slice(0, 300)}`);
      }
      throw e;
    }
  }
  throw new Error(`MCP 调用 ${tool} 失败`);
}

// 查询 mmwx 用户（按用户名精确匹配）
export async function findMmwxUser(username) {
  const r = await mcpCall('user_list');
  return (((r && r.users) || []).find(x => x.username === username)) || null;
}

/**
 * 发放 流量/时长 到 mmwx 用户账号（脱离抽奖中心）。
 * @param {string} username mmwx 用户名（来自 /bindmmwx）
 * @param {object} prize { type:'traffic'|'days', gb:数字, days:数字 }
 * @returns {{ok:boolean, message?:string, error?:string}}
 */
export async function grantToMmwx(username, prize) {
  username = (username || '').trim();
  if (!username) return { ok: false, error: '缺少 mmwx 用户名' };
  try {
    const u = await findMmwxUser(username);
    if (!u) return { ok: false, error: 'mmwx 账号不存在：' + username + '（请确认 /bindmmwx 的用户名正确）' };

    const curGB = Number(u.traffic_limit_override_gb ?? u.traffic_limit_gb ?? 0) || 0;
    const curEnd = u.package_end_date || null;
    const hasEnd = !!curEnd && new Date(curEnd) >= new Date();

    let newGB, newEnd;
    if (prize.type === 'traffic') {
      newGB = Math.max(0, curGB + (Number(prize.gb) || 0));
      newEnd = hasEnd ? curEnd : addDaysStr(todayStr(), 30); // 无到期日给保底 30 天
    } else if (prize.type === 'days') {
      newGB = curGB;
      newEnd = addDaysStr(hasEnd ? curEnd : todayStr(), Number(prize.days) || 0);
      if (new Date(newEnd) < new Date(todayStr())) newEnd = todayStr();
    } else {
      return { ok: false, error: '未知奖品类型：' + prize.type };
    }

    // 节点：优先沿用用户当前套餐节点，否则动态兜底
    let nodes = DYNAMIC_NODES;
    if (u.package_id) {
      try {
        const pkgs = await mcpCall('package_list');
        const cur = (((pkgs && pkgs.packages) || []).find(p => p.id === u.package_id));
        if (cur && Array.isArray(cur.nodes) && cur.nodes.length) nodes = cur.nodes;
      } catch (e) { /* 用兜底节点 */ }
    }

    // 获取/更新专属叠加套餐
    const pkgName = EXCLUSIVE_PREFIX + username;
    const listRes = await mcpCall('package_list');
    const myPkgs = (((listRes && listRes.packages) || []).filter(p => p.name === pkgName));
    let pkgId;
    if (myPkgs.length) {
      await mcpCall('package_update', { id: myPkgs[0].id, name: pkgName, traffic_limit_gb: newGB, cycle_days: 30, nodes });
      pkgId = myPkgs[0].id;
    } else {
      const cp = await mcpCall('package_create', { name: pkgName, traffic_limit_gb: newGB, cycle_days: 30, nodes, traffic_mode: 'twoway' });
      pkgId = (cp && cp.id) || (cp && cp.package && cp.package.id);
      if (!pkgId) throw new Error('建叠加套餐失败');
    }

    // 分配（指定到期日）
    const ar = await mcpCall('package_assign', { username, package_id: pkgId, expire_date: newEnd });
    if (ar && ar.ok === false) throw new Error(ar.message || '套餐分配失败');

    const detail = prize.type === 'traffic'
      ? `流量 ${curGB}GB → ${newGB}GB（到期 ${newEnd}）`
      : `时长 +${prize.days} 天（预计到期 ${newEnd}）`;
    return { ok: true, message: '已发放：' + detail };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

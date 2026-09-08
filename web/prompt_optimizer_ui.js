// H3MediaBoard 提示词优化 UI（v3-T5：工具条 + 设置对话框 + 优化执行流程，Goohai-MiniMax-H3_Integration 移植适配）。
// 高级节点媒体板（node.__mb.root，media_board.js 已建）下方挂"提示词工具条"五件套：
// 计时 / 模型名 / ↻ 还原 / ✦ 优化 / ⚙ 设置。⚙ 弹出优化器设置对话框。
// ✦ 未在优化时启动优化、优化中点击取消（GH runPromptOptimization / cancelOptimization 语义）。
//
// 与 GH（minimax_h3_integration.js）的关键差异（适配点）：
//   1) 路由前缀 /h3mediaboard/optimizer，节点 H3Ref2v_AdvancedMediaTaskInput；
//   2) 工具条挂到 node.__mb.root 尾部：DOM 顺序 listEl（素材栏）→ errorEl（错误行）→ 工具条，
//      即素材栏下方、提示词 textarea 上方（textarea 属 prompt widget，在本 DOM widget 之下）；
//   3) 设置持久化双写 optimizer_state widget（JSON 字符串）+ node.properties["h3mb_opt_state"]，
//      恢复时 widget 优先；api_key 永不进入这两处——密钥只随 POST /config 请求体发送，
//      由后端分流落盘本机 optimizer_keys.json，前端只通过 has_api_key 显示状态（绝不回显明文）；
//   4) 无 i18n（文案硬编码中文）、无 auto_optimize（设置项与持久化结构均不出现）；
//   5) GH 的 migrateProviderApiKeys / migrateLegacyOptimizerDefault 迁移逻辑跳过（新节点无旧数据）；
//   6) 无 prompt_override 输入：refreshPromptConnection 的上游占用分支整体去掉；
//   7) payload 按提示词标签 <Picture n>/<Video n>/<Audio n> 收集素材（mbParsePromptTags +
//      node.__mb.items 同类序号映射），不用 GH 的槽位枚举；task 由 payload 空否给
//      "T2VA"/"HYBRID"（后端按标签兜底重算）；label 用 H3 官方小写 "picture n" 等格式。
import { app } from "../../../scripts/app.js";
import { mbParsePromptTags, mbCollectRefs, mbSplitPromptSegments } from "./mb_utils.js";

// ---- 常量（GH :4-13 适配） ----
const OPTIMIZER_ROUTE = "/h3mediaboard/optimizer";
// Task 5 优化完成提示音（本插件自带音频，相对本文件同目录）
const OPTIMIZER_DONE_SOUND_URL = new URL("./audio/done.mp3", import.meta.url).href;
const MB_OPT_NODE = "H3Ref2v_AdvancedMediaTaskInput";
const MB_OPT_STATE_KEY = "h3mb_opt_state";
const MB_OPT_STATE_WIDGET = "optimizer_state";
// ★ 前端优化请求超时（毫秒）：与后端 prompt_optimizer.py 的 OPTIMIZE_TIMEOUT（默认 660 秒）
// 配套——本值 = 后端值 + 5 秒裕量，让后端的"优化超时"错误消息能回显到界面，
// 而不是前端先静默中止。改超时需两处同步：后端 OPTIMIZE_TIMEOUT 与本常量。
const MB_OPT_TIMEOUT_MS = 665000;

// 服务商预设（GH optimizerProviders :1660-1669，custom 文案直接中文化）
const MB_OPT_PROVIDERS = {
  runninghub: { label: "RunningHub 国内版（推荐）", url: "https://www.runninghub.cn/openapi/v2", model: "openai/gpt-5.6-sol", protocol: "runninghub" },
  runninghub_overseas: { label: "RunningHub 海外版", url: "https://www.runninghub.ai/openapi/v2", model: "openai/gpt-5.6-sol", protocol: "runninghub" },
  openai: { label: "OpenAI", url: "https://api.openai.com/v1", model: "gpt-4.1-mini", protocol: "openai" },
  gemini: { label: "Google Gemini", url: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-2.5-flash", protocol: "gemini" },
  openrouter: { label: "OpenRouter", url: "https://openrouter.ai/api/v1", model: "google/gemini-2.5-flash", protocol: "openai" },
  dashscope: { label: "阿里云百炼", url: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-vl-max", protocol: "openai" },
  siliconflow: { label: "SiliconFlow", url: "https://api.siliconflow.cn/v1", model: "Qwen/Qwen2.5-VL-72B-Instruct", protocol: "openai" },
  custom: { label: "自定义", url: "", model: "", protocol: "openai" },
};

// 工作流运行状态监控（GH installWorkflowStateMonitor :35-49 精简版）：
// 本地模型优化期间运行工作流需禁用 ✦（GH refreshPromptConnection 的 localBlocked 分支）。
let mbOptWorkflowRunning = false;
let mbOptWorkflowMonitorInstalled = false;
const mbOptWorkflowNodes = new Set();
// 优化完成提示音实例（GH playOptimizerCompleteSound :2140-2147 的模块级变量）
let mbOptDoneAudio = null;

function mbOptUpdateWorkflowState(running) {
  mbOptWorkflowRunning = running;
  for (const node of [...mbOptWorkflowNodes]) {
    try {
      if (!node.__mbOpt) continue;
      // GH updateWorkflowState :1225-1228：工作流开跑时若本地模型优化进行中，
      // 立即取消（本地推理占 VRAM，工作流需要释放）。
      if (running && node.__mbOpt.optimizing && node.__mbOpt.settings?.mode === "local") {
        mbOptCancel(node);
      }
      mbOptRefreshToolbar(node);
    } catch {
      /* 节点可能已销毁，忽略 */
    }
  }
}

function mbOptInstallWorkflowMonitor() {
  if (mbOptWorkflowMonitorInstalled) return;
  mbOptWorkflowMonitorInstalled = true;
  const update = (running) => mbOptUpdateWorkflowState(running);
  app.api.addEventListener("execution_start", () => update(true));
  app.api.addEventListener("executing", (event) => {
    if (event?.detail == null) update(false);
  });
  for (const name of ["execution_success", "execution_error", "execution_interrupted"]) {
    app.api.addEventListener(name, () => update(false));
  }
}

// ---- 基础工具（GH make :412-415 / widget :360 / fetchOptimizerJson :1723-1735） ----
function mbOptWidget(node, name) {
  return node.widgets?.find((w) => w.name === name);
}

function mbOptMake(tag, css = {}, text = "") {
  const el = document.createElement(tag);
  Object.assign(el.style, css);
  if (text) el.textContent = text;
  return el;
}

async function mbOptFetchJson(path, options = {}, retryEmpty = true) {
  const response = await app.api.fetchApi(path, options);
  const text = await response.text();
  if (!text.trim() && retryEmpty) {
    // 空响应偶发（服务启动早期），稍候重试一次并加缓存破坏参数
    await new Promise((resolve) => setTimeout(resolve, 120));
    const separator = path.includes("?") ? "&" : "?";
    return mbOptFetchJson(`${path}${separator}_=${Date.now()}`, options, false);
  }
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`模型列表接口返回了无效数据 (HTTP ${response.status})`);
  }
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

// 1.49.6 隐藏通道 widget（与 media_board.js mbSetHidden 同机制，来源见其注释）：
// 画布绘制看 widget.hidden，Vue 面板看 widget.options.hidden。
function mbOptHideWidget(w) {
  if (!w) return;
  w.hidden = true;
  if (w.options) w.options.hidden = true;
}

// 1.49.6：multiline STRING 由 useStringWidget 走 WidgetTextarea（Vue 渲染），
// 面板内 <textarea> 才是实际编辑面（与 media_board.js mbPromptTextarea 同结论）。
// media_board.js 不导出这些查找函数且本任务不改它，这里小范围复刻。
function mbOptPromptTextarea(node) {
  const root = node.__mb?.root;
  if (root?.isConnected) {
    const ta = root.closest(".lg-node")?.querySelector("textarea");
    if (ta) return ta;
  }
  const w = mbOptWidget(node, "prompt");
  const legacy = w?.inputEl || w?.element?.querySelector?.("textarea");
  return legacy?.isConnected ? legacy : null;
}

function mbOptPromptText(node) {
  const ed = node.__mbEditor;
  if (ed) return ed.getText();
  const ta = mbOptPromptTextarea(node);
  if (ta) return ta.value ?? "";
  return mbOptWidget(node, "prompt")?.value ?? "";
}

// GH setPromptWidget :370-376 适配：先走 widget 常规通道，再同步可见 textarea
// （1.49.6 中 textarea 才是真实编辑面，需派发 input 让 Vue 层感知）。
function mbOptSetPrompt(node, value) {
  const next = value ?? "";
  const w = mbOptWidget(node, "prompt");
  if (w && w.value !== next) {
    w.value = next;
    w.callback?.call(w, w.value);
  }
  const ed = node.__mbEditor;
  if (ed) {
    // 富文本编辑器路径：setText 负责 chips 重渲染（textarea 已隐藏，无需再同步）
    if (ed.getText() !== next) ed.setText(next);
    return;
  }
  const ta = mbOptPromptTextarea(node);
  if (ta && ta.value !== next) {
    ta.value = next;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

// ---- 持久化（GH persistState :520-529 模式改写） ----
// 双写：optimizer_state widget + node.properties["h3mb_opt_state"]；恢复时 widget 优先。
// settings 只含后端脱敏后的公开配置（GET/POST /config 均不回显明文），
// api_key / api_keys 永不进入这两个位置。
function mbOptPersist(node) {
  const st = node.__mbOpt;
  if (!st) return;
  const value = JSON.stringify({
    settings: st.settings || null,
    before: st.before ?? null,
    cache: st.cache || null,
  });
  if (node.properties[MB_OPT_STATE_KEY] !== value) node.properties[MB_OPT_STATE_KEY] = value;
  const w = mbOptWidget(node, MB_OPT_STATE_WIDGET);
  if (w && w.value !== value) w.value = value;
}

// 恢复：widget 优先，node.properties 兜底（GH :488-495 同款读取顺序）。
// 工作流加载时 widget 值在 onConfigure 链之后才应用，扩展注册处有 50/300ms 定时兜底。
function mbOptRestoreState(node) {
  const st = node.__mbOpt;
  if (!st) return;
  let saved = {};
  try {
    saved = JSON.parse(node.properties?.[MB_OPT_STATE_KEY] || "{}") || {};
  } catch {
    saved = {};
  }
  const w = mbOptWidget(node, MB_OPT_STATE_WIDGET);
  if (typeof w?.value === "string" && w.value) {
    try {
      Object.assign(saved, JSON.parse(w.value) || {});
    } catch {
      /* 坏 JSON 忽略，走 properties 兜底 */
    }
  }
  st.settings = saved.settings && typeof saved.settings === "object" ? saved.settings : null;
  st.before = typeof saved.before === "string" && saved.before ? saved.before : null;
  st.cache = saved.cache && typeof saved.cache === "object" ? saved.cache : null;
  mbOptRefreshToolbar(node);
}

// ---- 工具条 ----
// GH configuredOptimizerName :934-956 原样移植（品牌名大小写美化 + 服务商中文标签）
function mbOptConfiguredName(settings) {
  if (!settings) return "";
  if (settings.mode === "local") {
    const name = String(settings.local_model || "").split(/[\\/]/).pop();
    return name ? `本地：${name}` : "";
  }
  const rawName = String(settings.model || "").trim().split("/").pop();
  const name = rawName
    .replace(/^gpt(?=[-_.\d])/i, "GPT")
    .replace(/^grok(?=[-_.\d])/i, "Grok")
    .replace(/^gemini(?=[-_.\d])/i, "Gemini")
    .replace(/^qwen(?=[-_.\d])/i, "Qwen")
    .replace(/^claude(?=[-_.\d])/i, "Claude")
    .replace(/^deepseek(?=[-_.\d])/i, "DeepSeek")
    .replace(/^doubao(?=[-_.\d])/i, "Doubao")
    .replace(/^minimax(?=[-_.\d])/i, "MiniMax");
  const providerName =
    ({
      runninghub: "RunningHub 国内版",
      runninghub_overseas: "RunningHub 海外版",
      openai: "OpenAI",
      gemini: "Google Gemini",
      openrouter: "OpenRouter",
      dashscope: "阿里云百炼",
      siliconflow: "SiliconFlow",
      custom: "API",
    })[settings.provider] || "API";
  return name ? `${providerName}: ${name}` : "";
}

// 工具条状态刷新（GH refreshOptimizerName :957-961 + refreshPromptConnection :1216-1224 适配）：
// 去掉 prompt_override 上游占用分支；保留"本地模式且工作流运行中禁用 ✦"（GH localBlocked）。
// 优化中不禁用 ✦：GH 用 spin 动画标识进行中，此时点击 ✦ 触发取消（T5 语义）。
function mbOptRefreshToolbar(node) {
  const st = node.__mbOpt;
  if (!st?.toolbar) return;
  const t = st.toolbar;
  const text = mbOptConfiguredName(st.settings);
  t.model.textContent = text;
  t.model.removeAttribute("title");
  const localBlocked = mbOptWorkflowRunning && st.settings?.mode === "local";
  t.optimize.disabled = localBlocked;
  t.reset.disabled = false;
  t.reset.classList.toggle("visible", st.before != null);
  t.elapsed.classList.toggle("visible", !!st.optimizing);
}

// 悬停提示（GH delayedTooltip :1237-1250 移植，文案中文化）
function mbOptDelayTip(button, getText) {
  let timer = null;
  let tip = null;
  const clear = () => {
    clearTimeout(timer);
    timer = null;
    tip?.remove();
    tip = null;
  };
  button.addEventListener("mouseenter", () => {
    timer = setTimeout(() => {
      tip = mbOptMake("div", {}, getText());
      tip.className = "mb-opt-tip";
      document.body.append(tip);
      const rect = button.getBoundingClientRect();
      const centeredLeft = rect.left + rect.width / 2 - tip.offsetWidth / 2;
      tip.style.left = `${Math.max(4, Math.min(window.innerWidth - tip.offsetWidth - 4, centeredLeft))}px`;
      tip.style.top = `${Math.max(4, rect.top - tip.offsetHeight - 5)}px`;
    }, 1000);
  });
  button.addEventListener("mouseleave", clear);
  button.addEventListener("pointerdown", clear);
}

// 工具条 DOM（GH :720-726 五件套同序：计时 / 模型名 / ↻ / ✦ / ⚙）
function mbOptBuildToolbar(node) {
  const st = node.__mbOpt;
  const bar = mbOptMake("div");
  bar.className = "mb-opt-tools";
  const elapsed = mbOptMake("span");
  elapsed.className = "mb-opt-elapsed";
  const model = mbOptMake("span");
  model.className = "mb-opt-model";
  const resetBtn = mbOptMake("button", {}, "↻");
  resetBtn.type = "button";
  resetBtn.className = "mb-opt-tool mb-opt-reset";
  const optimizeBtn = mbOptMake("button", {}, "✦");
  optimizeBtn.type = "button";
  optimizeBtn.className = "mb-opt-tool mb-opt-optimize";
  const gearBtn = mbOptMake("button", {}, "⚙");
  gearBtn.type = "button";
  gearBtn.className = "mb-opt-tool";
  bar.append(elapsed, model, resetBtn, optimizeBtn, gearBtn);
  // DOM 顺序：listEl（素材栏）→ errorEl（错误行）→ 工具条（最后）。
  // root 属媒体板 DOM widget，其 widget 排在 prompt widget 之前，
  // 因此工具条位于素材栏下方、提示词 textarea 上方。
  node.__mb.root.appendChild(bar);
  st.toolbar = { bar, elapsed, model, reset: resetBtn, optimize: optimizeBtn, gear: gearBtn };
  resetBtn.onclick = () => mbOptReset(node);
  optimizeBtn.onclick = () => mbOptOptimize(node);
  gearBtn.onclick = () => mbOptOpenSettings(node);
  mbOptDelayTip(optimizeBtn, () => (st.optimizing ? "优化中，点击取消" : "优化提示词"));
  mbOptDelayTip(resetBtn, () => "还原到优化前");
  mbOptDelayTip(gearBtn, () => "优化器设置");
}

// 高度记账：media_board.js 的 getMinHeight 只算素材栏+错误行，不含工具条。
// 本任务不动 media_board.js：原位包一层 options.getMinHeight。
// 1.49.6 证据：DOMWidgetImpl.computeLayoutSize 每次布局实时读取
// options.getMinHeight（comfyui_frontend_package settingStore 分块），
// 故工具条 offsetHeight 会在下一次布局自动计入节点高度。
function mbOptPatchMinHeight(node) {
  const st = node.__mbOpt;
  const options = node.__mb?.domWidget?.options;
  if (!options || options.__mbOptPatched) return;
  if (typeof options.getMinHeight !== "function") return;
  options.__mbOptPatched = true;
  const base = options.getMinHeight;
  // 节点最小高度 = 素材栏 + 工具条 + 编辑器最小值（60px + 6 顶距 + 4 边框）。
  // 不用编辑器 offsetHeight：flex 填充后它等于当前可用高度，会让节点无法再缩小。
  options.getMinHeight = () => base() + (st.toolbar?.bar?.offsetHeight || 0) + 70;
  // GH 同款：DOM widget 声明占满节点窗体高度（否则 widget 停在 minHeight，
  // 节点拉大后多出的空间是空白）。编辑器在 flex 列里吸收余量（纯 CSS 跟随）。
  options.getHeight = () => "100%";
  node.setDirtyCanvas?.(true, true);
  requestAnimationFrame(() => {
    try {
      if (!node.__mbOpt) return;
      if (!Array.isArray(node.size) || typeof node.computeSize !== "function") return;
      node.setSize([node.size[0], node.computeSize()[1]]);
    } catch {
      /* 个别状态下尺寸重算不可用，忽略（布局时 getMinHeight 兜底） */
    }
  });
}

// ---- v3.1：富文本提示词编辑器（GH ghh3-prompt-rich 思路简化版） ----
// 单一文本变量（plain），contenteditable 只是它的富渲染视图：合法标签 <Picture n>
// 渲染为「缩略图 + 标签文字」chip；缩略图 contenteditable=false 且提取时被忽略，
// 标签文字保留在 DOM 文本流中参与提取，因此底层文本永远是纯标签文字。
// 编辑器把 value/selectionStart/selectionEnd/setRangeText/setSelectionRange 多态成
// textarea 接口（GH :664-697 同款），media_board.js 的插入逻辑零改动即可复用。
// 输入时全量重渲染 chips 并恢复光标（GH renderPromptHighlights 同款策略）。

function mbOptEditorExtract(el) {
  const walk = (node) => {
    if (!node) return "";
    if (node.nodeType === Node.TEXT_NODE) return node.data;
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    if (node.classList?.contains("mb-opt-chip-thumb")) return "";
    if (node.tagName === "BR") return "\n";
    return Array.from(node.childNodes).map(walk).join("");
  };
  const value = walk(el).replace(/\r/g, "");
  // Chromium 可能保留孤立 BR 作为光标容器，不算提示词字符
  return /^\n*$/.test(value) ? "" : value;
}

function mbOptSetEditorSelection(el, start, end = start) {
  const selection = window.getSelection();
  if (!selection) return;
  const locate = (target) => {
    let remaining = Math.max(0, target);
    let location = null;
    const visit = (node) => {
      if (location || node.classList?.contains?.("mb-opt-chip-thumb")) return;
      if (node.nodeType === Node.TEXT_NODE) {
        if (remaining <= node.data.length) location = [node, remaining];
        else remaining -= node.data.length;
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.tagName === "BR") {
        const parent = node.parentNode;
        const index = [...parent.childNodes].indexOf(node);
        if (remaining === 0) location = [parent, index];
        else if (remaining === 1) location = [parent, index + 1];
        else remaining -= 1;
        return;
      }
      for (const child of node.childNodes) {
        visit(child);
        if (location) return;
      }
    };
    visit(el);
    if (location) return location;
    return [el, el.childNodes.length];
  };
  const [sn, so] = locate(start);
  const [en, eo] = locate(end);
  const range = document.createRange();
  range.setStart(sn, so);
  range.setEnd(en, eo);
  selection.removeAllRanges();
  selection.addRange(range);
}

function mbOptEditorOffsets(el) {
  const walkText = (node) => {
    if (!node) return "";
    if (node.nodeType === Node.TEXT_NODE) return node.data;
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    if (node.classList?.contains?.("mb-opt-chip-thumb")) return "";
    if (node.tagName === "BR") return "\n";
    return Array.from(node.childNodes).map(walkText).join("");
  };
  const selection = window.getSelection();
  if (!selection?.rangeCount || !el.contains(selection.anchorNode)) {
    const len = walkText(el).length;
    return [len, len];
  }
  const textOffsetTo = (targetNode, targetOffset) => {
    let result = "";
    let found = false;
    const visit = (node) => {
      if (found || !node) return;
      if (node === targetNode) {
        if (node.nodeType === Node.TEXT_NODE) result += node.data.slice(0, targetOffset);
        else if (node.nodeType === Node.ELEMENT_NODE) {
          for (let i = 0; i < Math.min(targetOffset, node.childNodes.length); i++) {
            result += walkText(node.childNodes[i]);
          }
        }
        found = true;
        return;
      }
      if (node.nodeType === Node.TEXT_NODE) {
        result += node.data;
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.classList?.contains?.("mb-opt-chip-thumb")) return;
      if (node.tagName === "BR") {
        result += "\n";
        return;
      }
      for (const child of node.childNodes) {
        visit(child);
        if (found) break;
      }
    };
    visit(el);
    return result.length;
  };
  const anchor = textOffsetTo(selection.anchorNode, selection.anchorOffset);
  const focus = textOffsetTo(selection.focusNode, selection.focusOffset);
  return [Math.min(anchor, focus), Math.max(anchor, focus)];
}

function mbOptAppendPlain(el, text) {
  const parts = String(text).split("\n");
  parts.forEach((part, index) => {
    if (part) el.append(document.createTextNode(part));
    if (index < parts.length - 1) el.append(document.createElement("br"));
  });
}

function mbOptResolveChip(node, kind, n) {
  let count = 0;
  for (const it of node.__mb?.items || []) {
    if (it.kind !== kind) continue;
    count += 1;
    if (count === n) return it;
  }
  return null;
}

function mbOptAppendChip(node, el, seg) {
  const token = document.createElement("span");
  token.className = "mb-opt-chip";
  const item = mbOptResolveChip(node, seg.kind, seg.n);
  if (item) {
    if (seg.kind === "audio") {
      const thumb = document.createElement("span");
      thumb.className = "mb-opt-chip-thumb mb-opt-chip-audio";
      thumb.contentEditable = "false";
      token.appendChild(thumb);
    } else {
      const thumb = document.createElement(seg.kind === "video" ? "video" : "img");
      thumb.className = "mb-opt-chip-thumb";
      thumb.contentEditable = "false";
      thumb.draggable = false;
      if (seg.kind === "video") {
        thumb.muted = true;
        thumb.preload = "metadata";
      }
      thumb.src = mbOptViewUrl(item.path);
      token.appendChild(thumb);
    }
  }
  const tag = document.createElement("span");
  const colorClass = seg.kind === "image" ? " mb-opt-chip-tag-picture" : seg.kind === "video" ? " mb-opt-chip-tag-video" : "";
  tag.className = `mb-opt-chip-tag${colorClass}`;
  tag.textContent = seg.raw;
  token.appendChild(tag);
  el.appendChild(token);
}

// 编辑器高度联动（GH 同款纯 CSS 方案，无 JS 测量）：
// DOM widget 经 getHeight="100%" 占满节点可用区（见 mbOptPatchMinHeight），
// .mb-root 为 flex 列（height:100%），编辑器 flex:1 1 60px 吸收全部余量，
// min-height:60px、底部贴底。节点拉大/拉小由 CSS 弹性布局原生跟随，
// 不依赖测量与观察器（Vue 面板元素重建也不会失效）。
function mbOptRenderChips(node, editor) {
  const el = editor.element;
  const keepFocus = document.activeElement === el;
  const restore = keepFocus ? mbOptEditorOffsets(el) : null;
  el.replaceChildren();
  const plain = editor.getText();
  for (const seg of mbSplitPromptSegments(plain)) {
    if (seg.type === "text") mbOptAppendPlain(el, seg.text);
    else mbOptAppendChip(node, el, seg);
  }
  el.classList.toggle("mb-opt-empty", !plain);
  if (restore) {
    el.focus({ preventScroll: true });
    mbOptSetEditorSelection(el, restore[0], restore[1]);
  }
}

function mbOptSyncPromptWidget(node, value) {
  const w = mbOptWidget(node, "prompt");
  if (!w) return;
  const next = value ?? "";
  if (w.value === next) return;
  w.value = next;
  w.callback?.call(w, w.value);
}

// 构建富文本编辑器并挂到素材栏 DOM 根（工具条之后、隐藏的 prompt widget 之前）。
// node.__mbEditor 同时充当 media_board.js 的插入目标（textarea 接口多态）。
// 已知代价（GH 同款方案固有）：每键全量重渲染破坏 contenteditable 原生撤销栈，
// Ctrl+Z 行为不可靠，本版本不实现自定义撤销。
function mbOptBuildEditor(node) {
  const el = document.createElement("div");
  el.className = "mb-opt-editor";
  el.contentEditable = "true";
  el.spellcheck = false;
  el.dataset.placeholder = "提示词：点击素材卡片插入标签，如 <Picture 1>、<Video 1>、<Audio 1>";

  let plain = "";
  const editor = {
    element: el,
    getText: () => plain,
    setText: (v) => {
      const next = String(v ?? "");
      if (next === plain) return; // 相等短路：onConfigure 双定时器会重复调用
      plain = next;
      mbOptRenderChips(node, editor);
      mbOptSyncPromptWidget(node, plain);
    },
    refreshChips: () => mbOptRenderChips(node, editor),
  };
  node.__mbEditor = editor;

  // textarea 接口多态（GH :664-697 同款）：media_board.js 的 mbPromptTextarea
  // 会优先返回本元素，插入/光标逻辑零改动。
  Object.defineProperties(el, {
    // 注意：value 的 setter 只更新 plain、不重渲染 chips（textarea 语义）。
    // 需要"赋值并刷新显示"的调用方请走 editor.setText / mbOptSetPrompt。
    value: {
      configurable: true,
      get: () => plain,
      set: (v) => {
        plain = String(v ?? "");
      },
    },
    selectionStart: { configurable: true, get: () => mbOptEditorOffsets(el)[0] },
    selectionEnd: { configurable: true, get: () => mbOptEditorOffsets(el)[1] },
  });
  el.setRangeText = (replacement, start, end, mode = "end") => {
    const next = plain.slice(0, start) + replacement + plain.slice(end);
    plain = next;
    mbOptRenderChips(node, editor);
    const caret = mode === "select" ? [start, start + replacement.length] : [start + replacement.length, start + replacement.length];
    el.focus();
    mbOptSetEditorSelection(el, caret[0], caret[1]);
  };
  el.setSelectionRange = (start, end) => mbOptSetEditorSelection(el, start, end);

  el.addEventListener("input", () => {
    const extracted = mbOptEditorExtract(el);
    if (extracted === plain) {
      // 文本未变（如插入的 setRangeText 已重渲染过）：只同步 widget，跳过二次重渲染
      mbOptSyncPromptWidget(node, plain);
      return;
    }
    plain = extracted;
    mbOptRenderChips(node, editor);
    mbOptSyncPromptWidget(node, plain);
  });
  // 还原初始文本（工作流加载的 widget 值在 onConfigure 兜底里再同步一次）
  plain = mbOptWidget(node, "prompt")?.value ?? "";
  mbOptRenderChips(node, editor);
  return editor;
}

function buildOptimizerBar(node) {
  if (node.__mbOpt || !node.__mb?.root) return;
  mbOptInjectCss();
  mbOptInstallWorkflowMonitor();
  node.properties = node.properties || {};
  const st = {
    settings: null,
    optimizing: false,
    starting: false, // 启动阶段（settings 加载 await 期间）防双击双发（T5，GH 无此防护）
    before: null,
    cache: null, // {signature, originalPrompt, result}（T5 缓存，随持久化保存）
    toolbar: null,
    abort: null, // 进行中请求的 AbortController（T5）
    requestId: null, // 进行中请求的 request_id（T5，取消时回传后端）
    timer: null, // 优化计时 setInterval 句柄（T5）
  };
  node.__mbOpt = st;

  // optimizer_state 是序列化通道 widget（JSON 字符串），与 media_list 同样隐藏
  const stateWidget = mbOptWidget(node, MB_OPT_STATE_WIDGET);
  mbOptHideWidget(stateWidget);
  // v3.1：提示词改为富文本编辑器渲染，官方 multiline widget 隐藏为值通道
  mbOptHideWidget(mbOptWidget(node, "prompt"));
  if (stateWidget) node.widgets = node.widgets.slice();

  mbOptBuildToolbar(node);
  // v3.1：编辑器挂到素材栏 DOM 根末尾（工具条之后），提示词输入区即编辑器
  node.__mb.root.appendChild(mbOptBuildEditor(node).element);
  // flex 列布局标记：只在有编辑器的根上启用（基础节点不受影响）
  node.__mb.root.classList.add("mb-opt-root");
  mbOptPatchMinHeight(node);
  mbOptWorkflowNodes.add(node);
  mbOptRestoreState(node); // 内部含 mbOptRefreshToolbar
}

// ---- 供 Task 5 复用的公开函数 ----
function mbOptSettings(node) {
  return node.__mbOpt?.settings || null;
}

// ↻ 还原到优化前（GH resetPrompt.onclick :2149-2155 适配：无上游占用分支）
function mbOptReset(node) {
  const st = node.__mbOpt;
  if (!st || st.before == null) return;
  if (st.cache?.originalPrompt === st.before) st.cache.result = mbOptPromptText(node);
  mbOptSetPrompt(node, st.before);
  st.before = null;
  mbOptPersist(node);
  mbOptRefreshToolbar(node);
}

// ---- Task 5：优化执行流程（GH :2032-2258 移植适配） ----

// 素材视图 URL（media_board.js mbViewUrl 同款，其不导出故小范围复刻）
function mbOptViewUrl(path) {
  const i = path.lastIndexOf("/");
  const subfolder = i >= 0 ? path.slice(0, i) : "";
  const filename = i >= 0 ? path.slice(i + 1) : path;
  return app.api.apiURL(
    "/view?filename=" + encodeURIComponent(filename) +
    "&subfolder=" + encodeURIComponent(subfolder) + "&type=input"
  );
}

// GH lowImageData :2032-2042 原样移植：canvas 压 ≤512px JPEG data URL
function mbOptLowImageData(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      const scale = Math.min(1, 512 / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      canvas.getContext("2d", { alpha: false }).drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.42));
    };
    image.onerror = () => reject(new Error("无法读取参考图片"));
    image.src = url;
  });
}

// GH lowVideoFrames :2044-2071 原样移植：0/中/末三帧（每帧 ≤512px JPEG data URL）
function mbOptLowVideoFrames(url) {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.preload = "metadata";
    video.onloadedmetadata = async () => {
      try {
        const duration = Number.isFinite(video.duration) ? video.duration : 0;
        const times = duration > 0 ? [0, duration / 2, Math.max(0, duration - 0.04)] : [0];
        const frames = [];
        for (const time of times) {
          const target = Math.min(time, Math.max(0, duration - 0.001));
          if (video.readyState < 2 || Math.abs(video.currentTime - target) > 0.002) {
            await new Promise((done, fail) => {
              const timeout = setTimeout(() => fail(new Error("视频取帧定位超时")), 10000);
              video.onseeked = () => {
                clearTimeout(timeout);
                done();
              };
              video.currentTime = target;
            });
          }
          const scale = Math.min(1, 512 / Math.max(video.videoWidth, video.videoHeight));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
          canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
          canvas.getContext("2d", { alpha: false }).drawImage(video, 0, 0, canvas.width, canvas.height);
          frames.push(canvas.toDataURL("image/jpeg", 0.42));
        }
        resolve(frames);
      } catch (error) {
        reject(error);
      }
    };
    video.onerror = () => reject(new Error("无法读取参考视频"));
    video.src = url;
  });
}

// 标签 → 被引用素材（薄包装）：核心序号映射逻辑在 mb_utils.js 的 mbCollectRefs
// （纯函数，已测），返回 [{kind, n, path, name}]（保持 items 顺序，
// n 为同 kind 角标 = 被引用标签号）。纯计算，无 DOM。
function mbOptRefs(node, prompt) {
  return mbCollectRefs(node.__mb?.items || [], mbParsePromptTags(prompt));
}

// 优化 payload 收集（GH optimizerMediaSpecs :2072-2090 + optimizerMediaPayload
// :2091-2113 适配，核心新逻辑）：
//   - 图片 → canvas 压 ≤512px JPEG data URL（GH lowImageData 同款）；
//   - 视频 → 0/中/末三帧（GH lowVideoFrames 同款）；RunningHub 模式只传
//     source_name 文件名（后端转 1fps 上传），不抽帧，且只传首个视频（GH 同款）；
//   - 音频 → 仅 {label, kind}（音频二进制不传，后端只作引用说明）；
//   - label 用 H3 官方小写格式："picture n" / "video n" / "audio n"；
//   - read_media === false 时不附加任何图像/帧（GH 同款，item 仍保留）。
async function mbOptCollectMedia(node, prompt) {
  const settings = node.__mbOpt?.settings || null;
  const readMedia = settings?.read_media !== false;
  const runninghub =
    settings?.mode !== "local" && ["runninghub", "runninghub_overseas"].includes(settings?.provider);
  const LABEL_OF = { image: "picture", video: "video", audio: "audio" };
  const payload = [];
  let runninghubImages = 0;
  let runninghubVideo = false;
  for (const ref of mbOptRefs(node, prompt)) {
    const label = `${LABEL_OF[ref.kind]} ${ref.n}`;
    const item = { kind: ref.kind, label };
    if (readMedia && ref.kind === "image") {
      // RunningHub 图片最多 8 张（GH runninghubImages < 8 同款，后端节点上限一致）
      if (!runninghub || runninghubImages < 8) {
        item.images = [await mbOptLowImageData(mbOptViewUrl(ref.path))];
      }
      runninghubImages += 1;
    } else if (readMedia && ref.kind === "video") {
      if (runninghub) {
        if (!runninghubVideo) item.source_name = ref.path;
        runninghubVideo = true;
      } else {
        item.images = await mbOptLowVideoFrames(mbOptViewUrl(ref.path));
      }
    }
    payload.push(item);
  }
  return payload;
}

// 缓存签名（GH optimizerContextSignature :2114-2116 适配）：
// prompt + duration + 被引用素材 path 集合（排序）+ 关键设置
// （provider/model/mode/read_media/output_language 直接影响模型输出；
// 本地模式换 local_model/local_mmproj/local_device/max_tokens 同样改变输出，必须参与签名）。
function mbOptSignature(node, prompt, settings) {
  const s = settings || node.__mbOpt?.settings || null;
  const duration = Number(mbOptWidget(node, "duration")?.value || 5);
  const paths = mbOptRefs(node, prompt).map((ref) => ref.path).sort();
  return JSON.stringify({
    prompt,
    duration,
    media: paths,
    settings: s && [
      s.mode, s.provider, s.model, s.read_media, s.output_language,
      s.local_model, s.local_mmproj, s.local_device, s.max_tokens,
    ],
  });
}

// GH applyOptimizedPrompt :2130-2139 适配（无 mode 分存）：
// 写回 prompt widget 值 + 官方 textarea（mbOptSetPrompt）+ ↻ 亮起 + 持久化。
function mbOptApplyOptimized(node, value, before) {
  const st = node.__mbOpt;
  st.before = before;
  mbOptSetPrompt(node, value);
  st.toolbar.reset.classList.add("visible");
  mbOptPersist(node);
  mbOptRefreshToolbar(node);
}

// GH playOptimizerCompleteSound :2140-2147 原样移植
function mbOptPlayDone() {
  try {
    mbOptDoneAudio?.pause();
    mbOptDoneAudio = new Audio(OPTIMIZER_DONE_SOUND_URL);
    mbOptDoneAudio.volume = 0.6;
    mbOptDoneAudio.play().catch(() => {});
  } catch {
    /* 自动播放被浏览器拦截等场景忽略 */
  }
}

// 后端取消请求（GH cancelOptimization :2156-2163 的 fetch 部分）
function mbOptCancelRequest(requestId) {
  app.api
    .fetchApi(`${OPTIMIZER_ROUTE}/cancel`, {
      method: "POST",
      body: new Blob([JSON.stringify({ request_id: requestId })], { type: "application/json" }),
    })
    .catch(() => {});
}

// GH cancelOptimization :2156-2163 移植：AbortController.abort() + POST /cancel
async function mbOptCancel(node) {
  const st = node.__mbOpt;
  if (!st?.optimizing) return;
  const requestId = st.requestId;
  st.abort?.abort();
  if (requestId) mbOptCancelRequest(requestId);
}

// GH runPromptOptimization :2196-2254 移植适配：
//   - 删 automatic 参数与 autoOptimize 分支（无自动优化）；
//   - 删 upstreamConnected 与 node.mode 检查（无 prompt_override 输入、无子图模式）；
//   - 缓存命中直接复用（跳过请求）；
//   - 任务判定：payload 空 → "T2VA"，非空 → "HYBRID"（后端兜底重算）；
//   - 请求体 {request_id, prompt, task, duration, media, config}（config 即公开设置，
//     密钥由后端 optimizer_keys.json 注入）；AbortController + MB_OPT_TIMEOUT_MS 超时兜底取消。
async function mbOptRun(node) {
  const st = node.__mbOpt;
  if (!st || st.optimizing || st.starting || node.graph !== app.graph) return false;
  st.starting = true;
  let settings;
  try {
    settings = await mbOptLoadSettings(node);
  } catch (error) {
    st.starting = false;
    alert(error.message);
    return false;
  }
  st.starting = false;
  const local = settings.mode === "local";
  if (local && mbOptWorkflowRunning) return false; // ✦ 已禁用，此处双保险
  if ((!local && !settings.has_api_key) || (local && !settings.local_model)) {
    alert(local ? "请先在设置中选择本地视觉模型" : "请先在设置中配置优化 API 密钥");
    mbOptOpenSettings(node);
    return false;
  }
  const prompt = mbOptPromptText(node);
  const duration = Number(mbOptWidget(node, "duration")?.value || 5);
  const signature = mbOptSignature(node, prompt, settings);
  const cache = st.cache;
  // 缓存命中（GH :2215-2216）：签名一致且当前文本等于优化前或优化结果 → 直接复用
  if (
    cache?.signature === signature && cache?.result &&
    (prompt === cache.originalPrompt || prompt === cache.result)
  ) {
    mbOptApplyOptimized(node, cache.result, cache.originalPrompt);
    return true;
  }
  st.optimizing = true;
  st.abort = new AbortController();
  st.requestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  const t = st.toolbar;
  t.optimize.classList.add("mb-opt-loading");
  t.elapsed.classList.add("visible");
  const started = performance.now();
  const refreshElapsed = () => {
    t.elapsed.textContent = `优化中：${Math.floor((performance.now() - started) / 1000)} s`;
  };
  refreshElapsed();
  st.timer = setInterval(refreshElapsed, 1000);
  mbOptRefreshToolbar(node);
  try {
    const media = await mbOptCollectMedia(node, prompt);
    const task = media.length ? "HYBRID" : "T2VA";
    const requestBody = {
      request_id: st.requestId,
      prompt,
      task,
      duration,
      media,
      config: settings,
    };
    const timeout = setTimeout(() => {
      const requestId = st.requestId;
      st.abort?.abort();
      if (requestId) mbOptCancelRequest(requestId);
    }, MB_OPT_TIMEOUT_MS);
    let data;
    try {
      const response = await app.api.fetchApi(`${OPTIMIZER_ROUTE}/optimize`, {
        method: "POST",
        signal: st.abort.signal,
        body: new Blob([JSON.stringify(requestBody)], { type: "application/json" }),
      });
      const text = await response.text();
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(
          /^\s*(?:<!doctype\s+html|<html)/i.test(text)
            ? "云端网关返回了网页而不是节点数据"
            : "提示词优化接口返回了无效数据"
        );
      }
      if (!response.ok) throw new Error(data.error || "提示词优化失败");
    } finally {
      clearTimeout(timeout);
    }
    st.cache = { signature, originalPrompt: prompt, result: data.prompt };
    mbOptApplyOptimized(node, data.prompt, prompt);
    mbOptPlayDone();
    return true;
  } catch (error) {
    if (error.name !== "AbortError") alert(error.message);
    return false;
  } finally {
    clearInterval(st.timer);
    st.timer = null;
    st.abort = null;
    st.requestId = null;
    st.optimizing = false;
    t.elapsed.classList.remove("visible");
    t.elapsed.textContent = "";
    t.optimize.classList.remove("mb-opt-loading");
    mbOptRefreshToolbar(node);
  }
}

// ✦ 点击（GH optimizePrompt.onclick :2255-2258）：未在优化 → 启动；优化中 → 取消
async function mbOptOptimize(node) {
  const st = node.__mbOpt;
  if (!st) return;
  if (st.optimizing) {
    await mbOptCancel(node);
    return;
  }
  await mbOptRun(node);
}

// ---- 配置加载（GH loadOptimizerSettings :1737-1775 移植，去掉迁移调用） ----
async function mbOptLoadSettings(node) {
  const st = node.__mbOpt;
  if (st.settings) {
    const s = st.settings;
    if (
      !Array.isArray(s.runninghub_models) || !s.runninghub_models.length ||
      !Array.isArray(s.runninghub_overseas_models) || !s.runninghub_overseas_models.length ||
      !Array.isArray(s.mmproj_models) || !s.mmproj_models.length
    ) {
      try {
        const defaults = await mbOptFetchJson(`${OPTIMIZER_ROUTE}/config`, { cache: "no-store" });
        st.settings = {
          ...defaults,
          ...st.settings,
          runninghub_models: defaults.runninghub_models || [],
          runninghub_overseas_models: defaults.runninghub_overseas_models || [],
          models: st.settings.models || defaults.models || [],
          mmproj_models: st.settings.mmproj_models || defaults.mmproj_models || [],
          missing_dependencies: st.settings.missing_dependencies || defaults.missing_dependencies || [],
        };
      } catch (error) {
        console.warn("[H3MediaBoard] 优化器设置刷新失败，沿用已保存设置:", error);
        st.settings = {
          ...st.settings,
          runninghub_models: st.settings.runninghub_models || [],
          runninghub_overseas_models: st.settings.runninghub_overseas_models || [],
          models: st.settings.models || [],
          mmproj_models: st.settings.mmproj_models || [],
          missing_dependencies: st.settings.missing_dependencies || [],
        };
      }
    }
    mbOptRefreshToolbar(node);
    return st.settings;
  }
  let defaults;
  try {
    defaults = await mbOptFetchJson(`${OPTIMIZER_ROUTE}/config`, { cache: "no-store" });
  } catch (error) {
    throw new Error(`无法加载提示词优化设置: ${error.message}`);
  }
  st.settings = defaults;
  mbOptRefreshToolbar(node);
  return st.settings;
}

// ---- 设置对话框（GH openOptimizerSettings :1776-2022 移植适配） ----
function mbOptOpenSettings(node) {
  mbOptLoadSettings(node)
    .then((current) => {
      const st = node.__mbOpt;
      if (!st) return;
      const overlay = mbOptMake("div");
      overlay.className = "mb-opt-overlay";
      const dialog = mbOptMake("div");
      dialog.className = "mb-opt-dialog";
      overlay.append(dialog);
      const title = mbOptMake("div", {}, "提示词优化设置");
      title.className = "mb-opt-title";
      dialog.append(title);
      // 行构造器：label 左列 + 控件右列；custom 行仅在"自定义"服务商下显示
      const row = (label, control, custom = false) => {
        const wrap = mbOptMake("label");
        wrap.className = `mb-opt-row${custom ? " mb-opt-custom" : ""}`;
        wrap.append(mbOptMake("span", {}, label), control);
        dialog.append(wrap);
        return control;
      };
      const mode = row("优化方式", mbOptMake("select"));
      mode.append(new Option("在线 API", "api"), new Option("本地视觉模型", "local"));
      mode.value = current.mode || "api";
      const provider = row("服务商", mbOptMake("select"));
      for (const [value, preset] of Object.entries(MB_OPT_PROVIDERS)) {
        provider.append(new Option(preset.label, value));
      }
      provider.value = current.provider || "runninghub";
      // 各服务商各自记住上次选的模型（GH providerModels 逻辑，不含任何密钥）
      const providerModels = { ...(current.provider_models || {}) };
      if (current.model && !providerModels[current.provider || "runninghub"]) {
        providerModels[current.provider || "runninghub"] = current.model;
      }

      // ---- API 密钥行（v3.2：password 输入框 + 单个保存按钮） ----
      // 打开对话框/切换服务商/改自定义 URL 时自动从本机读取该商已存 key 填入；
      // 点对话框"保存"时随 POST /config 落盘（预设商按 provider、自定义按 API URL
      // 一一对应；清空输入框保存即删除该商条目）。
      const keyRow = mbOptMake("div");
      keyRow.className = "mb-opt-row mb-opt-keyrow";
      keyRow.append(mbOptMake("span", {}, "API 密钥"));
      const keyBox = mbOptMake("div");
      keyBox.className = "mb-opt-keybox";
      const keyInput = mbOptMake("input");
      keyInput.type = "password";
      keyInput.placeholder = "本服务商的 API 密钥（仅保存到本机）";
      keyInput.autocomplete = "off";
      // GH 同款眼睛开关：切换密钥原文显示/隐藏
      const keyEyeBtn = mbOptMake("button", {}, "👁");
      keyEyeBtn.type = "button";
      keyEyeBtn.title = "显示/隐藏密钥";
      keyEyeBtn.onclick = () => {
        const show = keyInput.type === "password";
        keyInput.type = show ? "text" : "password";
        keyEyeBtn.textContent = show ? "🙈" : "👁";
      };
      keyBox.append(keyInput, keyEyeBtn);
      keyRow.append(keyBox);
      dialog.append(keyRow);
      // 自动读取本机该服务商（或自定义 URL）已存的 key 填入输入框
      const loadKeyIntoInput = async () => {
        const p = provider.value;
        const u = provider.value === "custom" ? url.value : "";
        try {
          const r = await mbOptFetchJson(
            `${OPTIMIZER_ROUTE}/keys?provider=${encodeURIComponent(p)}&api_url=${encodeURIComponent(u)}`
          );
          keyInput.value = typeof r?.key === "string" ? r.key : "";
        } catch {
          keyInput.value = "";
        }
      };
      // 不设独立保存按钮：key 随设置面板主"保存"一起落盘（body.api_key = keyInput.value，
      // 空串即删除该商条目）；点"取消"则本次所有改动（含 key 输入）一并放弃。

      const readMedia = mbOptMake("input");
      readMedia.type = "checkbox";
      readMedia.checked = current.read_media !== false;
      readMedia.className = "mb-opt-check";
      const language = mbOptMake("div");
      language.className = "mb-opt-language";
      for (const value of ["English", "中文"]) {
        const label = mbOptMake("label");
        const radio = mbOptMake("input");
        radio.type = "radio";
        radio.name = `mb-opt-output-language-${node.id}`;
        radio.value = value;
        radio.checked = (current.output_language || "中文") === value;
        label.append(radio, mbOptMake("span", {}, value));
        language.append(label);
      }
      const url = row("API URL", mbOptMake("input"), true);
      const model = row("模型", mbOptMake("input"), true);
      const protocol = row("协议", mbOptMake("select"), true);
      protocol.append(
        new Option("OpenAI Chat Completions", "openai"),
        new Option("OpenAI Responses", "responses"),
        new Option("Gemini GenerateContent", "gemini")
      );

      // ---- RunningHub 模型选择器（GH :1803-1848 原样移植） ----
      const runninghubModelGroup = mbOptMake("div");
      runninghubModelGroup.className = "mb-opt-model-row";
      const runninghubModel = mbOptMake("select");
      runninghubModel.className = "mb-opt-model-native";
      runninghubModelGroup.append(runninghubModel);
      const runninghubModelPicker = mbOptMake("button");
      runninghubModelPicker.type = "button";
      runninghubModelPicker.className = "mb-opt-model-picker";
      runninghubModelGroup.append(runninghubModelPicker);
      const refreshIcon =
        '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M17.65 6.35A7.95 7.95 0 0 0 12 4V1L7 6l5 5V7a5 5 0 0 1 4.9 4H20a8 8 0 0 0-2.35-4.65ZM12 17a5 5 0 0 1-4.9-4H4a8 8 0 0 0 8 7v3l5-5-5-5v4Z"/></svg>';
      const refreshRunninghubModels = mbOptMake("button");
      refreshRunninghubModels.type = "button";
      refreshRunninghubModels.className = "mb-opt-refresh";
      refreshRunninghubModels.innerHTML = refreshIcon;
      refreshRunninghubModels.title = "刷新 RunningHub 模型";
      refreshRunninghubModels.setAttribute("aria-label", "刷新 RunningHub 模型");
      runninghubModelGroup.append(refreshRunninghubModels);
      const runninghubModelMenu = mbOptMake("div");
      runninghubModelMenu.className = "mb-opt-model-menu";
      const runninghubModelSearch = mbOptMake("input");
      runninghubModelSearch.type = "search";
      runninghubModelSearch.placeholder = "搜索模型";
      runninghubModelSearch.className = "mb-opt-model-search";
      const runninghubModelResults = mbOptMake("div");
      runninghubModelResults.className = "mb-opt-model-results";
      runninghubModelMenu.append(runninghubModelSearch, runninghubModelResults);
      runninghubModelGroup.append(runninghubModelMenu);
      row("模型", runninghubModelGroup);
      const runninghubModelsByProvider = {
        runninghub: [...(current.runninghub_models || [])],
        runninghub_overseas: [...(current.runninghub_overseas_models || current.runninghub_models || [])],
      };
      let runninghubModels = runninghubModelsByProvider[provider.value] || [];
      const fillRunninghubModels = (
        models = runninghubModels,
        preserveValue = runninghubModel.value || current.model || "openai/gpt-5.6-sol"
      ) => {
        runninghubModels = models || [];
        runninghubModel.replaceChildren(...runninghubModels.map((value) => new Option(value, value)));
        if ([...runninghubModel.options].some((option) => option.value === preserveValue)) {
          runninghubModel.value = preserveValue;
        } else if ([...runninghubModel.options].some((option) => option.value === "openai/gpt-5.6-sol")) {
          runninghubModel.value = "openai/gpt-5.6-sol";
        }
        refreshRunninghubModelPicker();
        renderRunninghubModels();
      };
      for (const value of runninghubModels) runninghubModel.append(new Option(value, value));
      runninghubModel.value = providerModels[provider.value] || "openai/gpt-5.6-sol";
      const refreshRunninghubModelPicker = () => {
        runninghubModelPicker.textContent = runninghubModel.value || "";
      };
      const renderRunninghubModels = () => {
        const keyword = runninghubModelSearch.value.trim().toLowerCase();
        const filtered = keyword
          ? runninghubModels.filter((value) => value.toLowerCase().includes(keyword))
          : runninghubModels;
        runninghubModelResults.replaceChildren();
        if (!filtered.length) {
          const empty = mbOptMake("div", {}, "没有匹配的模型");
          empty.className = "mb-opt-model-empty";
          runninghubModelResults.append(empty);
          return;
        }
        for (const value of filtered) {
          const option = mbOptMake("button", {}, value);
          option.type = "button";
          option.className = "mb-opt-model-option";
          option.classList.toggle("selected", value === runninghubModel.value);
          option.onclick = () => {
            runninghubModel.value = value;
            refreshRunninghubModelPicker();
            runninghubModelMenu.classList.remove("open");
          };
          runninghubModelResults.append(option);
        }
      };
      refreshRunninghubModelPicker();
      renderRunninghubModels();
      runninghubModelPicker.onclick = () => {
        const opening = !runninghubModelMenu.classList.contains("open");
        runninghubModelMenu.classList.toggle("open", opening);
        if (opening) {
          runninghubModelSearch.value = "";
          renderRunninghubModels();
          requestAnimationFrame(() => runninghubModelSearch.focus());
        }
      };
      runninghubModelSearch.addEventListener("input", renderRunninghubModels);

      // ---- 本地模型选择器（GH :1849-1931 原样移植，含 mmproj 自动匹配） ----
      const localModelGroup = mbOptMake("div");
      localModelGroup.className = "mb-opt-model-row";
      const localModel = mbOptMake("select");
      localModel.className = "mb-opt-model-native";
      localModelGroup.append(localModel);
      const localModelPicker = mbOptMake("button");
      localModelPicker.type = "button";
      localModelPicker.className = "mb-opt-model-picker";
      localModelGroup.append(localModelPicker);
      const localModelMenu = mbOptMake("div");
      localModelMenu.className = "mb-opt-model-menu";
      const localModelSearch = mbOptMake("input");
      localModelSearch.type = "search";
      localModelSearch.placeholder = "搜索本地模型";
      localModelSearch.className = "mb-opt-model-search";
      const localModelResults = mbOptMake("div");
      localModelResults.className = "mb-opt-model-results";
      localModelMenu.append(localModelSearch, localModelResults);
      localModelGroup.append(localModelMenu);
      const refreshModels = mbOptMake("button");
      refreshModels.type = "button";
      refreshModels.className = "mb-opt-refresh";
      refreshModels.innerHTML = refreshIcon;
      refreshModels.title = "刷新本地模型";
      refreshModels.setAttribute("aria-label", "刷新本地模型");
      localModelGroup.append(refreshModels);
      row("本地模型", localModelGroup);
      const localMmproj = row("视觉投影模型 (mmproj)", mbOptMake("select"));
      const localDevice = row("本地设备", mbOptMake("select"));
      localDevice.append(new Option("自动", "auto"), new Option("GPU", "cuda"), new Option("CPU", "cpu"));
      localDevice.value = current.local_device || "cuda";
      const dependencyStatus = mbOptMake("div");
      dependencyStatus.className = "mb-opt-dependencies";
      dialog.append(dependencyStatus);
      const maxTokens = row("最大输出 tokens", mbOptMake("input"));
      maxTokens.type = "number";
      maxTokens.min = "512";
      maxTokens.max = "8192";
      maxTokens.step = "512";
      maxTokens.value = String(Math.max(512, Math.min(8192, Number(current.max_tokens) || 4096)));
      const normalizeMaxTokens = () => {
        const value = Number.parseInt(maxTokens.value, 10);
        maxTokens.value = String(Math.max(512, Math.min(8192, Number.isFinite(value) ? value : 4096)));
      };
      maxTokens.addEventListener("change", normalizeMaxTokens);
      row("输出语言", language);
      row("读取视觉参考素材", readMedia);

      let localModels = current.models || [];
      let mmprojModels = current.mmproj_models || [];
      let mmprojManuallySelected = !!current.local_mmproj;
      const selectedLocalModel = () => localModels.find((item) => item.relative_path === localModel.value);
      const fillMmprojModels = (models = mmprojModels, preserveValue = localMmproj.value || current.local_mmproj || "") => {
        mmprojModels = models || [];
        localMmproj.replaceChildren();
        localMmproj.append(
          new Option(mmprojModels.length ? "选择视觉投影模型" : "没有找到 mmproj 模型", "")
        );
        mmprojModels.forEach((item) => localMmproj.append(new Option(item.name, item.relative_path)));
        if ([...localMmproj.options].some((option) => option.value === preserveValue)) {
          localMmproj.value = preserveValue;
        }
      };
      const autoSelectMmproj = () => {
        const selected = selectedLocalModel();
        if (selected?.format !== "gguf") {
          localMmproj.value = "";
          return;
        }
        const best = selected.mmproj_candidates?.find((value) =>
          mmprojModels.some((item) => item.relative_path === value)
        );
        localMmproj.value = best || "";
      };
      const refreshModelPicker = () => {
        const selected = selectedLocalModel();
        localModelPicker.textContent = selected?.name || "没有找到可用的本地视觉模型";
      };
      const renderModelResults = () => {
        const keyword = localModelSearch.value.trim().toLowerCase();
        const filtered = keyword
          ? localModels.filter((item) => `${item.name} ${item.relative_path}`.toLowerCase().includes(keyword))
          : localModels;
        localModelResults.replaceChildren();
        if (!filtered.length) {
          const empty = mbOptMake("div", {}, "没有找到可用的本地视觉模型");
          empty.className = "mb-opt-model-empty";
          localModelResults.append(empty);
          return;
        }
        for (const item of filtered) {
          const option = mbOptMake("button", {}, item.name);
          option.type = "button";
          option.className = "mb-opt-model-option";
          option.classList.toggle("selected", item.relative_path === localModel.value);
          option.onclick = () => {
            localModel.value = item.relative_path;
            mmprojManuallySelected = false;
            refreshModelPicker();
            autoSelectMmproj();
            sync();
            localModelMenu.classList.remove("open");
          };
          localModelResults.append(option);
        }
      };
      const fillModels = (models = localModels, preserveValue = localModel.value || current.local_model || "") => {
        localModels = models || [];
        localModel.replaceChildren();
        localModels.forEach((item) => localModel.append(new Option(item.name, item.relative_path)));
        if ([...localModel.options].some((option) => option.value === preserveValue)) {
          localModel.value = preserveValue;
        }
        if (!localModel.options.length) localModel.append(new Option("没有找到可用的本地视觉模型", ""));
        refreshModelPicker();
        renderModelResults();
      };
      const showDependencies = (missing) => {
        dependencyStatus.textContent = missing?.length ? `缺失本地模型依赖: ${missing.join(", ")}` : "";
      };
      fillMmprojModels(current.mmproj_models);
      fillModels(current.models);
      if (!localMmproj.value) autoSelectMmproj();
      showDependencies(current.missing_dependencies);
      localModelPicker.onclick = () => {
        const opening = !localModelMenu.classList.contains("open");
        localModelMenu.classList.toggle("open", opening);
        if (opening) {
          localModelSearch.value = "";
          renderModelResults();
          requestAnimationFrame(() => localModelSearch.focus());
        }
      };
      localModelSearch.addEventListener("input", renderModelResults);
      localMmproj.addEventListener("change", () => {
        mmprojManuallySelected = !!localMmproj.value;
      });
      dialog.addEventListener("pointerdown", (event) => {
        if (!localModelGroup.contains(event.target)) localModelMenu.classList.remove("open");
        if (!runninghubModelGroup.contains(event.target)) runninghubModelMenu.classList.remove("open");
      });
      const withRefreshState = async (button, action) => {
        if (button.disabled) return;
        button.disabled = true;
        button.classList.add("loading");
        try {
          await action();
        } finally {
          button.classList.remove("loading");
          button.disabled = false;
        }
      };
      refreshRunninghubModels.onclick = () =>
        withRefreshState(refreshRunninghubModels, async () => {
          const selectedProvider = provider.value === "runninghub_overseas" ? "runninghub_overseas" : "runninghub";
          const data = await mbOptFetchJson(
            `${OPTIMIZER_ROUTE}/runninghub-models?provider=${encodeURIComponent(selectedProvider)}`,
            { cache: "no-store" }
          );
          const refreshed = selectedProvider === "runninghub_overseas" ? data.runninghub_overseas_models : data.runninghub_models;
          runninghubModelsByProvider[selectedProvider] = [...(refreshed || [])];
          fillRunninghubModels(runninghubModelsByProvider[selectedProvider]);
          st.settings = {
            ...(st.settings || current),
            runninghub_models: [...runninghubModelsByProvider.runninghub],
            runninghub_overseas_models: [...runninghubModelsByProvider.runninghub_overseas],
          };
        }).catch((error) => alert(error.message));
      refreshModels.onclick = () =>
        withRefreshState(refreshModels, async () => {
          const data = await mbOptFetchJson(`${OPTIMIZER_ROUTE}/models`, { cache: "no-store" });
          const previousModel = localModel.value;
          const previousMmproj = localMmproj.value;
          fillMmprojModels(data.mmproj_models, previousMmproj);
          fillModels(data.models, previousModel);
          const manualStillExists = mmprojManuallySelected && mmprojModels.some((item) => item.relative_path === previousMmproj);
          if (!manualStillExists) {
            mmprojManuallySelected = false;
            autoSelectMmproj();
          }
          st.settings = {
            ...(st.settings || current),
            models: [...localModels],
            mmproj_models: [...mmprojModels],
            missing_dependencies: data.missing_dependencies || [],
          };
          sync();
          showDependencies(data.missing_dependencies);
        }).catch((error) => alert(error.message));
      if (!current.models) refreshModels.click();
      // ---- sync：行显隐与服务商预设回填（GH :1971-1988 原样移植） ----
      const sync = () => {
        const custom = provider.value === "custom";
        const runninghub = provider.value === "runninghub" || provider.value === "runninghub_overseas";
        dialog.classList.toggle("custom", custom);
        const local = mode.value === "local";
        dialog.classList.toggle("local", local);
        [provider, keyRow, url, model, protocol].forEach((control) =>
          (control.closest("label") || control).classList.toggle("mb-opt-hidden", local)
        );
        runninghubModel.closest("label")?.classList.toggle("mb-opt-hidden", local || !runninghub);
        model.closest("label")?.classList.toggle("mb-opt-hidden", local || !custom);
        url.closest("label")?.classList.toggle("mb-opt-hidden", local || !custom);
        protocol.closest("label")?.classList.toggle("mb-opt-hidden", local || !custom);
        [localModel, localDevice, refreshModels].forEach((control) =>
          (control.closest("label") || control).classList.toggle("mb-opt-hidden", !local)
        );
        const gguf = selectedLocalModel()?.format === "gguf";
        localMmproj.closest("label")?.classList.toggle("mb-opt-hidden", !local || !gguf);
        dependencyStatus.classList.toggle("mb-opt-hidden", !local || !dependencyStatus.textContent);
        const preset = MB_OPT_PROVIDERS[provider.value];
        if (!custom) {
          url.value = preset.url;
          model.value = preset.model;
          protocol.value = preset.protocol;
        }
      };
      url.value = current.api_url || "";
      model.value = current.model || "";
      protocol.value = current.protocol || "openai";
      // 自定义 API URL 变更 -> 重新读取该 URL 对应的 key
      url.addEventListener("change", () => loadKeyIntoInput());
      // 服务商切换（GH :1990-2003 适配：去掉 per-provider 密钥暂存）
      provider.addEventListener("change", () => {
        const previousProvider = provider.dataset.previousValue || current.provider || "runninghub";
        if (previousProvider === "runninghub" || previousProvider === "runninghub_overseas") {
          providerModels[previousProvider] = runninghubModel.value;
        }
        provider.dataset.previousValue = provider.value;
        if (provider.value === "runninghub" || provider.value === "runninghub_overseas") {
          const preserve = providerModels[provider.value] || MB_OPT_PROVIDERS[provider.value].model;
          fillRunninghubModels(runninghubModelsByProvider[provider.value] || [], preserve);
        }
        sync();
        loadKeyIntoInput();
      });
      mode.addEventListener("change", sync);
      sync();
      loadKeyIntoInput();
      provider.dataset.previousValue = provider.value;
      const actions = mbOptMake("div");
      actions.className = "mb-opt-actions";
      const cancel = mbOptMake("button", {}, "取消");
      const save = mbOptMake("button", {}, "保存");
      actions.append(cancel, save);
      dialog.append(actions);
      const close = () => overlay.remove();
      cancel.onclick = close;
      overlay.addEventListener("pointerdown", (event) => {
        if (event.target === overlay) close();
      });
      save.onclick = async () => {
        const outputLanguage = language.querySelector("input:checked")?.value || "中文";
        const preset = MB_OPT_PROVIDERS[provider.value];
        const selectedModel =
          provider.value === "runninghub" || provider.value === "runninghub_overseas"
            ? runninghubModel.value
            : model.value;
        providerModels[provider.value] = selectedModel;
        normalizeMaxTokens();
        const body = {
          mode: mode.value,
          provider: provider.value,
          api_url: provider.value === "custom" ? url.value : preset?.url || url.value,
          model: selectedModel,
          protocol: provider.value === "custom" ? protocol.value : preset?.protocol || protocol.value,
          read_media: readMedia.checked,
          output_language: outputLanguage,
          local_model: localModel.value,
          local_mmproj: localMmproj.value,
          local_device: localDevice.value,
          max_tokens: Number(maxTokens.value),
          provider_models: { ...providerModels },
        };
        // 密钥仅随请求体发送（当前服务商/自定义 URL 一一对应），
        // 后端落盘本机 optimizer_keys.json；空串即删除该商条目；响应不回显明文。
        body.api_key = keyInput.value;
        try {
          const response = await mbOptFetchJson(`${OPTIMIZER_ROUTE}/config`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          if (response?.warning) alert(`[H3MediaBoard] ${response.warning}`);
          st.settings = { ...(st.settings || {}), ...response };
          mbOptPersist(node);
          mbOptRefreshToolbar(node);
          close();
        } catch (error) {
          alert(`保存优化器设置失败: ${error.message}`);
        }
      };
      document.body.append(overlay);
    })
    .catch((error) => alert(error.message));
}

// ---- 样式注入（GH 内联样式 :459-471 移植，类名改 mb-opt- 前缀，颜色沿用） ----
function mbOptInjectCss() {
  if (document.getElementById("mb-opt-style")) return;
  const style = document.createElement("style");
  style.id = "mb-opt-style";
  style.textContent = `
.mb-opt-tools{display:flex;align-items:center;justify-content:flex-end;gap:3px;padding:2px 5px;box-sizing:border-box;background:#1d2731;border-radius:0 0 6px 6px;z-index:4}
.mb-opt-elapsed{display:none;margin-right:auto;color:#617684;font:9px/17px Arial,sans-serif}
.mb-opt-elapsed.visible{display:inline-block}
.mb-opt-model{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right;color:rgba(96,116,130,.6);font:8px/17px Arial,sans-serif;margin-left:auto;margin-right:17px}
.mb-opt-tool{height:17px;min-width:17px;padding:0 3px;border:0;border-radius:3px;background:#1d2731;color:#6f8291;font:11px/17px Arial,sans-serif;cursor:pointer;opacity:.72;flex:0 0 auto}
.mb-opt-optimize{font-size:13px}
.mb-opt-tool:hover{color:#9aabb8;background:#24323e}
.mb-opt-tool:disabled{opacity:.25;cursor:not-allowed}
.mb-opt-reset{display:none;font-size:12px;line-height:15px}
.mb-opt-reset.visible{display:inline-block}
.mb-opt-loading{color:#0aa4d6!important;opacity:1!important;animation:mb-opt-spin 1.6s linear infinite}
@keyframes mb-opt-spin{to{transform:rotate(360deg)}}
.mb-opt-tip{position:fixed;z-index:10100;padding:4px 7px;border-radius:4px;background:#111a22;color:#cbd7df;border:1px solid #344753;font:10px/1.2 Arial,sans-serif;pointer-events:none;white-space:nowrap}
.mb-opt-overlay{position:fixed;inset:0;z-index:10050;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.58);font:12px Arial,sans-serif}
.mb-opt-dialog{width:min(470px,calc(100vw - 30px));background:#17222c;color:#d7e3ec;border:1px solid #344958;border-radius:9px;box-shadow:0 18px 50px rgba(0,0,0,.5);padding:14px}
.mb-opt-title{font-size:12px;margin-bottom:12px;white-space:nowrap}
.mb-opt-row{display:grid;grid-template-columns:140px minmax(0,1fr);align-items:center;gap:8px;min-height:38px;margin:0}
.mb-opt-row>span{white-space:nowrap}
.mb-opt-row input,.mb-opt-row select{width:100%;box-sizing:border-box;background:#1d2b36;color:#dce7ee;border:1px solid #3a4d5b;border-radius:4px;padding:6px;font:inherit}
.mb-opt-hidden{display:none!important}
.mb-opt-model-row{position:relative;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:7px;min-width:0}
.mb-opt-model-native{display:none}
.mb-opt-model-picker{width:100%;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;background:#1d2b36;color:#dce7ee;border:1px solid #3a4d5b;border-radius:4px;padding:6px 24px 6px 7px;cursor:pointer;position:relative;font:inherit}
.mb-opt-model-picker:after{content:"⌄";position:absolute;right:7px}
.mb-opt-model-menu{display:none;position:absolute;left:0;top:calc(100% + 4px);z-index:10070;box-sizing:border-box;width:max-content;min-width:100%;max-width:calc(100vw - 30px);padding:5px;background:#17222c;border:1px solid #3a4d5b;border-radius:5px;box-shadow:0 8px 22px rgba(0,0,0,.45)}
.mb-opt-model-menu.open{display:block}
.mb-opt-model-search{display:block;width:100%;min-width:100%;margin-bottom:5px;font:inherit}
.mb-opt-model-results{max-height:285px;overflow:auto}
.mb-opt-model-option{display:block;width:max-content;min-width:100%;border:0;background:transparent;color:#dce7ee;text-align:left;padding:6px;border-radius:3px;white-space:nowrap;cursor:pointer;font:inherit}
.mb-opt-model-option:hover,.mb-opt-model-option.selected{background:#274252}
.mb-opt-model-empty{padding:7px;color:#8294a2;font-size:12px}
.mb-opt-refresh{display:flex;align-items:center;justify-content:center;width:30px;height:30px;margin:0;background:#1d2b36;color:#cbd8e0;border:1px solid #3a4d5b;border-radius:4px;padding:0;cursor:pointer;font-size:16px;line-height:1;white-space:nowrap;transition:background .12s,color .12s,border-color .12s}
.mb-opt-refresh:hover{background:#263b49;border-color:#4c6879;color:#e4f1f5}
.mb-opt-refresh:active{background:#17535a;border-color:#2a7c85;color:#fff}
.mb-opt-refresh.loading{background:#17535a;border-color:#2a7c85;color:#42d8e5;cursor:wait}
.mb-opt-refresh.loading svg{animation:mb-opt-spin 1.2s linear infinite}
.mb-opt-refresh:disabled{opacity:.85}
.mb-opt-dependencies{margin:6px 0;color:#d98d97;font-size:12px;line-height:1.35}
.mb-opt-checks{margin:0}
.mb-opt-actions{display:flex;justify-content:flex-end;gap:7px;margin-top:28px}
.mb-opt-actions button{border:1px solid #3a4d5b;border-radius:4px;background:#1d2b36;color:#cbd8e0;padding:5px 12px;cursor:pointer}
.mb-opt-actions button:last-child{background:#17535a;border-color:#26717a;color:#e0f2f2}
.mb-opt-custom{display:none}
.mb-opt-dialog.custom .mb-opt-custom{display:grid}
.mb-opt-check{justify-self:end;width:auto!important}
.mb-opt-language{display:grid;grid-template-columns:1fr 1fr;width:100%;align-items:center}
.mb-opt-language label{display:flex;align-items:center;gap:4px;white-space:nowrap}
.mb-opt-language label:first-child{justify-self:start}
.mb-opt-language label:last-child{justify-self:end}
.mb-opt-language input{width:auto}
.mb-opt-keybox{display:flex;align-items:center;gap:7px;min-width:0}
.mb-opt-key-status-view{display:flex;align-items:center;gap:7px;min-width:0}
.mb-opt-key-edit-view{display:flex;align-items:center;gap:7px;flex:1;min-width:0}
.mb-opt-key-status{color:#9fb0bc;font-size:12px;white-space:nowrap}
.mb-opt-key-status.mb-opt-key-pending{color:#e0b96b}
.mb-opt-keybox button{border:1px solid #3a4d5b;border-radius:4px;background:#1d2b36;color:#cbd8e0;padding:3px 8px;cursor:pointer;font:inherit;white-space:nowrap}
.mb-opt-keybox button:hover{background:#263b49}
.mb-opt-keybox input{flex:1;min-width:0}
.mb-opt-tools{margin-top:10px}
/* 高级节点编辑器联动（GH 同款纯 CSS 方案）：root 为 flex 列占满 widget，
   编辑器 flex 吸收余量，min 60px，底部贴底；内容溢出垂直滚动 */
.mb-root.mb-opt-root{display:flex;flex-direction:column;height:100%;box-sizing:border-box}
.mb-opt-root .mb-list,.mb-opt-root .mb-error,.mb-opt-root .mb-opt-tools{flex:0 0 auto}
.mb-opt-editor{display:block;width:100%;flex:1 1 60px;min-height:60px;box-sizing:border-box;margin-top:6px;border:1px solid #334a5d;border-radius:6px;background:#1d2731;color:#e1e9ef;padding:7px;overflow-x:hidden;overflow-y:auto;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;font:12px/1.5 Arial,sans-serif;outline:none;user-select:text;caret-color:#e1e9ef}
.mb-opt-editor.mb-opt-empty:before{content:attr(data-placeholder);color:#52616d;white-space:pre-wrap;pointer-events:none}
.mb-opt-chip{display:inline-flex;align-items:center;vertical-align:middle;white-space:nowrap;margin:0 2px}
.mb-opt-chip-thumb{flex:0 0 26px;width:26px;height:26px;box-sizing:border-box;margin-right:4px;border:1px solid rgba(91,124,143,.72);border-radius:5px;background:#14222d;object-fit:cover;vertical-align:middle;user-select:none;pointer-events:none}
.mb-opt-chip-thumb.mb-opt-chip-audio{display:inline-flex;align-items:center;justify-content:center;border-radius:50%;color:#77a5b7;font:14px/26px Arial,sans-serif}
.mb-opt-chip-thumb.mb-opt-chip-audio:before{content:"♫";font-size:13px}
.mb-opt-chip-tag{display:inline-block;padding:1px 5px;border-radius:5px;background:#3b3b3b;color:#cdcdcd;-webkit-text-fill-color:#cdcdcd;font-size:.86em;line-height:1.35;white-space:nowrap}
.mb-opt-chip-tag-video{background:#493f59}
.mb-opt-chip-tag-picture{background:#31515a}
`;
  document.head.appendChild(style);
}

// ---- 扩展注册（brief Step 3） ----
app.registerExtension({
  name: "H3MediaBoard.PromptOptimizerUI",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== MB_OPT_NODE) return;
    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      // media_board.js 先注册故其 onNodeCreated 包装先执行，node.__mb 正常已就绪；
      // 若注册顺序不可靠，走 setTimeout 50ms 重试一次兜底。
      if (!this.__mbOpt) {
        if (this.__mb) buildOptimizerBar(this);
        else setTimeout(() => !this.__mbOpt && this.__mb && buildOptimizerBar(this), 50);
      }
      return r;
    };
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const r = onConfigure?.apply(this, arguments);
      // 工作流加载时 widget 值在 onConfigure 链之后才应用，与 media_board.js 同款定时兜底
      setTimeout(() => {
        if (!this.__mbOpt) return;
        mbOptRestoreState(this);
        this.__mbEditor?.setText(mbOptWidget(this, "prompt")?.value ?? "");
      }, 50);
      setTimeout(() => {
        if (!this.__mbOpt) return;
        mbOptRestoreState(this);
        this.__mbEditor?.setText(mbOptWidget(this, "prompt")?.value ?? "");
      }, 300);
      return r;
    };
    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      const r = onRemoved?.apply(this, arguments);
      // GH onRemoved :3132-3155 适配：取消进行中请求（abort + POST /cancel）、
      // 停计时与提示音。不移植 queue hook（v3 全人工触发优化）。
      const st = this.__mbOpt;
      if (st) {
        clearInterval(st.timer);
        st.timer = null;
        st.abort?.abort();
        if (st.requestId) mbOptCancelRequest(st.requestId);
        mbOptDoneAudio?.pause();
        mbOptDoneAudio = null;
      }
      mbOptWorkflowNodes.delete(this);
      this.__mbOpt = null;
      return r;
    };
  },
});

// brief Interfaces 约定的公开函数（mbOptCollectMedia / mbOptSignature 为 T5 新增）
export {
  mbOptSettings,
  mbOptOpenSettings,
  mbOptReset,
  mbOptOptimize,
  mbOptRefreshToolbar,
  mbOptCollectMedia,
  mbOptSignature,
};

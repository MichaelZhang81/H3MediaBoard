// H3MediaBoard 前端素材栏。素材清单序列化进 media_list widget（JSON），官方序列化机制兜底。
// 选材交互（借鉴 Goohai-MiniMax-H3_Integration，更简版）：
//   点占位框/⟳ -> 弹系统文件选择器 -> 按扩展名识别类型 -> 上传到 input 目录 -> 卡片出现/替换。
//   （浏览器拿不到磁盘绝对路径，上传复制到 input 目录是系统选择器的唯一可行机制，
//    与官方 LoadImage 的拖拽上传行为一致；源文件不动。）
import { app } from "../../../scripts/app.js";
import {
  KIND_OF,
  mbSlots,
  mbFmtTime,
  mbReorder,
  mbInsertIndex,
  mbMakeTag,
  mbDetectKind,
} from "./mb_utils.js";

const MEDIA_BOARD = {
  cardSize: 120,          // ★ 全局卡片边长参数：改这一处，面板所有尺寸随之变化
  maxImage: 9,
  maxVideo: 3,
  maxAudio: 3,
  nameBarHeight: 22,
  gap: 6,
  dragThreshold: 4,
};

const KIND_LIMIT = { image: "maxImage", video: "maxVideo", audio: "maxAudio" };
const ACCEPT_ALL = "image/*,video/*,audio/*";
const ACCEPT_OF = { image: "image/*", video: "video/*", audio: "audio/*" };

function mbWidget(node, name) {
  return node.widgets?.find((w) => w.name === name);
}

function mbParse(node) {
  const raw = mbWidget(node, "media_list")?.value;
  if (typeof raw !== "string" || !raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr)
      ? arr.filter((it) => it && typeof it.path === "string" && KIND_OF[it.kind])
      : [];
  } catch (e) {
    return [];
  }
}

function mbCommit(node) {
  const w = mbWidget(node, "media_list");
  if (w) w.value = JSON.stringify(node.__mb.items);
  mbResize(node);
}

function mbResize(node) {
  node.setDirtyCanvas?.(true, true);
}

function mbViewUrl(path) {
  const i = path.lastIndexOf("/");
  const subfolder = i >= 0 ? path.slice(0, i) : "";
  const filename = i >= 0 ? path.slice(i + 1) : path;
  return app.api.apiURL(
    "/view?filename=" + encodeURIComponent(filename) +
    "&subfolder=" + encodeURIComponent(subfolder) + "&type=input"
  );
}

// 1.49.6 适配（证据见报告）：LGraphNode 不再创建 el 属性；multiline STRING
// 走 useStringWidget.addMultilineWidget（DOM widget，type='customtext'），
// 注册表把 'customtext' 归入 WidgetTextarea（Vue 渲染），面板里可见的
// <textarea> 在节点面板 overlay（GraphCanvas.vue 的 TransformPane 内
// LGraphNode）中，widget 自带的 element/inputEl 是未挂载的孤儿节点。
// 本插件的 DOM widget 元素会被 WidgetDOM.vue 移入同一面板，
// 因此从素材栏根元素向上找 .lg-node 面板根，再在其中查 textarea。
function mbNodePanel(node) {
  const root = node.__mb?.root;
  if (root?.isConnected) {
    const panel = root.closest(".lg-node");
    if (panel) return panel;
  }
  // DOM widget 尚未挂载时按 data-node-id 兜底（限定本节点面板）
  if (typeof document === "undefined") return null;
  return (
    document.querySelector(`[data-node-id="${node.id}"]`) ||
    document.querySelector(`[data-node-id="${String(node.id)}"]`) ||
    null
  );
}

function mbPromptTextarea(node) {
  // 1.49.6 主路径：面板内 textarea 优先；widget 自带 textarea（孤儿节点）
  // 仅在已挂载（老前端渲染路径）时兜底。
  const panel = mbNodePanel(node)?.querySelector("textarea");
  if (panel) return panel;
  const w = mbWidget(node, "prompt");
  const legacy = w?.inputEl || w?.element?.querySelector?.("textarea");
  return legacy?.isConnected ? legacy : null;
}

function mbInsertTag(node, idx) {
  const ta = mbPromptTextarea(node);
  if (!ta) return;
  const s = ta.selectionStart ?? ta.value?.length ?? 0;
  const e = ta.selectionEnd ?? s;
  const item = node.__mb.items[idx];
  const badge = node.__mb.slots[idx]?.badge;
  const tag = mbMakeTag(item, badge);
  if (!tag) return;
  ta.setRangeText(tag, s, e, "end");
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.focus();
  const pos = s + tag.length;
  ta.setSelectionRange(pos, pos);
}

function mbWirePointer(node, card, idx) {
  const ta = mbPromptTextarea(node);
  let startX = 0;
  let startY = 0;
  let dragging = false;
  let wasFocused = false;

  card.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".mb-remove")) return;
    if (e.button !== 0) return;
    wasFocused = !!ta && document.activeElement === ta;
    startX = e.clientX;
    startY = e.clientY;
    dragging = false;
    const cleanup = () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", cancel, true);
      window.removeEventListener("blur", cancel);
      // 仅在拖动中才可能持有捕获；释放失败（捕获已丢失）无害
      try {
        if (card.hasPointerCapture?.(e.pointerId)) card.releasePointerCapture(e.pointerId);
      } catch (err) {
        /* 忽略 */
      }
    };
    const move = (ev) => {
      if (!dragging && Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) > MEDIA_BOARD.dragThreshold) {
        dragging = true;
        card.style.opacity = "0.45";
        // 捕获必须延迟到拖动判定之后：pointerdown 立即捕获会把 pointerup/click
        // 重定向到卡片本身，导致 ⟳/播放按钮的 click 处理器永远不触发。
        try {
          card.setPointerCapture(e.pointerId);
        } catch (err) {
          /* 个别环境下捕获不可用，走 window 捕获监听兜底 */
        }
      }
      if (dragging) mbDragMove(node, card, ev);
    };
    const up = (ev) => {
      cleanup();
      card.style.opacity = "";
      if (dragging) {
        mbDragEnd(node, idx, ev);
      } else if (wasFocused) {
        mbInsertTag(node, idx);
      }
    };
    // pointercancel（系统中断）/窗口失焦（视口外异常释放）：只恢复状态不落位
    const cancel = () => {
      cleanup();
      card.style.opacity = "";
      node.__mb.dragTarget = -1;
    };
    // 必须用捕获阶段：WidgetDOM.vue 的容器 @pointermove/up.stop 会在冒泡阶段
    // 截断事件，window 冒泡监听收不到；捕获阶段先于 Vue 处理器执行。
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", cancel, true);
    window.addEventListener("blur", cancel);
  });
}

function mbDragMove(node, draggedCard, ev) {
  const list = node.__mb.listEl;
  const cards = Array.from(list.querySelectorAll(".mb-card:not(.mb-placeholder)"));
  // 命中测试：遍历除被拖卡片外的卡片矩形，X+Y 双轴判定，计算插入索引
  const rects = [];
  for (const c of cards) {
    if (c === draggedCard) continue;
    rects.push(c.getBoundingClientRect());
  }
  node.__mb.dragTarget = mbInsertIndex(rects, ev.clientX, ev.clientY);
}

function mbDragEnd(node, fromIdx, ev) {
  const insertIndex = node.__mb.dragTarget;
  node.__mb.dragTarget = -1;
  if (insertIndex >= 0 && insertIndex !== fromIdx) {
    node.__mb.items = mbReorder(node.__mb.items, fromIdx, insertIndex);
    mbCommit(node);
  }
  mbRender(node);
}

function mbWirePlayback(node, card, mediaEl, preview) {
  const playBtn = document.createElement("button");
  playBtn.className = "mb-play";
  playBtn.textContent = "▶";
  playBtn.title = "播放/暂停";
  const timeEl = document.createElement("div");
  timeEl.className = "mb-time";
  timeEl.textContent = "--:--";

  mediaEl.addEventListener("loadedmetadata", () => {
    timeEl.textContent = mbFmtTime(mediaEl.duration);
  });
  mediaEl.addEventListener("timeupdate", () => {
    if (!mediaEl.paused) timeEl.textContent = mbFmtTime(mediaEl.duration - mediaEl.currentTime);
  });
  mediaEl.addEventListener("ended", () => {
    playBtn.textContent = "▶";
    timeEl.textContent = mbFmtTime(mediaEl.duration);
  });
  mediaEl.addEventListener("play", () => (playBtn.textContent = "⏸"));
  mediaEl.addEventListener("pause", () => (playBtn.textContent = "▶"));
  playBtn.addEventListener("click", () => {
    if (mediaEl.paused) {
      // 同一时刻只允许一个素材发声：暂停节点内其他正在播放的媒体
      mbPauseOthers(node, mediaEl);
      mediaEl.play().catch(() => {});
    } else {
      mediaEl.pause();
    }
  });
  return { playBtn, timeEl };
}

function mbPauseOthers(node, except) {
  const cards = node.__mb.listEl?.querySelectorAll(".mb-card") || [];
  cards.forEach((c) => {
    const m = c.__mbMedia;
    if (!m || m === except) return;
    const el = m instanceof HTMLVideoElement ? m : m.audio;
    if (el && !el.paused) el.pause();
  });
}

function mbCard(node, item, idx) {
  const s = MEDIA_BOARD;
  const card = document.createElement("div");
  card.className = "mb-card";
  card.style.width = s.cardSize + "px";
  card.style.height = s.cardSize + s.nameBarHeight + "px";

  const preview = document.createElement("div");
  preview.className = "mb-preview";
  preview.style.width = s.cardSize + "px";
  preview.style.height = s.cardSize + "px";
  card.appendChild(preview);

  const badge = document.createElement("div");
  badge.className = "mb-badge";
  badge.textContent = node.__mb.slots[idx]?.badge || "";
  preview.appendChild(badge);

  // 预览区（图片缩略图 / 视频元素 / 音频图标）
  if (item.kind === "image") {
    const img = document.createElement("img");
    img.className = "mb-preview-img";
    img.draggable = false;
    img.src = mbViewUrl(item.path);
    img.onerror = () => card.classList.add("mb-missing");
    preview.appendChild(img);
  } else if (item.kind === "video") {
    const v = document.createElement("video");
    v.className = "mb-preview-img";
    v.preload = "metadata";
    v.src = mbViewUrl(item.path);
    v.addEventListener("error", () => card.classList.add("mb-missing"));
    const { playBtn, timeEl } = mbWirePlayback(node, card, v, preview);
    preview.appendChild(v);
    preview.appendChild(playBtn);
    preview.appendChild(timeEl);
    card.__mbMedia = v;
  } else {
    const icon = document.createElement("div");
    icon.className = "mb-audio-icon";
    icon.textContent = "♪";
    const a = document.createElement("audio");
    a.preload = "metadata";
    a.src = mbViewUrl(item.path);
    a.addEventListener("error", () => card.classList.add("mb-missing"));
    const { playBtn, timeEl } = mbWirePlayback(node, card, a, preview);
    preview.appendChild(icon);
    preview.appendChild(playBtn);
    preview.appendChild(timeEl);
    card.__mbMedia = { audio: a, playBtn, timeEl };
  }

  // 灰色文件名条：截断 + 替换 + 移除
  const nameBar = document.createElement("div");
  nameBar.className = "mb-name";
  nameBar.style.height = s.nameBarHeight + "px";

  const nameSpan = document.createElement("span");
  nameSpan.className = "mb-name-text";
  nameSpan.textContent = item.name || item.path;
  nameSpan.title = item.name || item.path;
  nameBar.appendChild(nameSpan);

  const replaceBtn = document.createElement("button");
  replaceBtn.className = "mb-name-btn";
  replaceBtn.textContent = "⟳";
  replaceBtn.title = "替换素材";
  replaceBtn.addEventListener("click", () => mbChooseFile(node, item.kind, idx));
  nameBar.appendChild(replaceBtn);

  const removeBtn = document.createElement("button");
  removeBtn.className = "mb-name-btn mb-remove";
  removeBtn.textContent = "×";
  removeBtn.title = "移除素材（不删除磁盘文件）";
  removeBtn.addEventListener("mousedown", (e) => e.stopPropagation());
  removeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    node.__mb.items.splice(idx, 1);
    node.__mb.errorText = "";
    mbCommit(node);
    mbRender(node);
  });
  nameBar.appendChild(removeBtn);
  card.appendChild(nameBar);

  mbWirePointer(node, card, idx);
  return card;
}

function mbPlaceholder(node) {
  const s = MEDIA_BOARD;
  const ph = document.createElement("div");
  ph.className = "mb-card mb-placeholder";
  ph.style.width = s.cardSize + "px";
  ph.style.height = s.cardSize + s.nameBarHeight + "px";
  ph.title = "添加素材（图片/视频/音频）";
  const plus = document.createElement("div");
  plus.className = "mb-plus";
  plus.textContent = "+";
  ph.appendChild(plus);
  ph.addEventListener("mousedown", (e) => e.stopPropagation());
  ph.addEventListener("click", () => mbChooseFile(node, null, -1));
  return ph;
}

function mbShowInfo(node, text) {
  const s = node.__mb;
  s.errorText = text;
  s.errorEl.classList.toggle("mb-info", true);
  mbRefreshError(node);
}

function mbShowError(node, text) {
  const s = node.__mb;
  s.errorText = text;
  s.errorEl.classList.toggle("mb-info", false);
  mbRefreshError(node);
}

function mbRefreshError(node) {
  const s = node.__mb;
  if (!s.errorEl) return;
  s.errorEl.textContent = s.errorText || "";
  s.errorEl.style.display = s.errorText ? "" : "none";
}

// 上限提示文案由 MEDIA_BOARD 上限参数派生（改一处全局生效）
function mbLimitText(kind) {
  if (kind === "image") return `最多${MEDIA_BOARD.maxImage}张图片`;
  if (kind === "video") return `最多${MEDIA_BOARD.maxVideo}个视频`;
  return `最多${MEDIA_BOARD.maxAudio}个音频`;
}

async function mbUploadFile(file) {
  // Goohai-MiniMax-H3_Integration 同款上传通道：
  // POST /upload/image 接受任意文件类型，复制进 input 目录并返回相对路径；
  // 同名同内容自动去重，源文件不动。
  const body = new FormData();
  body.append("image", file, file.name);
  body.append("type", "input");
  const resp = await app.api.fetchApi("/upload/image", { method: "POST", body });
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  const r = await resp.json();
  return [r.subfolder, r.name].filter(Boolean).join("/");
}

// 系统文件选择器（借鉴 Goohai choose()，一次一个）：
// kindFilter = null -> 图/视/音都收；否则只收该类型。
// replaceIdx = -1 -> 新增；>=0 -> 原位替换。
function mbChooseFile(node, kindFilter, replaceIdx) {
  const s = node.__mb;
  if (s.uploading) return;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = kindFilter ? ACCEPT_OF[kindFilter] : ACCEPT_ALL;
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const kind = mbDetectKind(file.name);
    if (!kind) {
      mbShowError(node, `不支持的文件类型: ${file.name}`);
      return;
    }
    if (kindFilter && kind !== kindFilter) {
      mbShowError(node, `该位置只能选择${mbKindLabel(kindFilter)}素材`);
      return;
    }
    if (replaceIdx < 0) {
      const count = s.items.filter((it) => it.kind === kind).length;
      if (count >= MEDIA_BOARD[KIND_LIMIT[kind]]) {
        mbShowError(node, mbLimitText(kind));
        return;
      }
    }
    s.uploading = true;
    mbShowInfo(node, `上传中: ${file.name} …`);
    try {
      const path = await mbUploadFile(file);
      const item = { kind, path, name: file.name };
      if (replaceIdx >= 0 && s.items[replaceIdx]) {
        s.items[replaceIdx] = item;
      } else {
        s.items.push(item);
      }
      mbShowInfo(node, "");
      s.errorText = "";
      mbCommit(node);
      mbRender(node);
    } catch (err) {
      mbShowError(node, `上传失败: ${file.name}（${err?.message || err}）`);
    } finally {
      s.uploading = false;
    }
  };
  input.click();
}

function mbKindLabel(kind) {
  return kind === "image" ? "图片" : kind === "video" ? "视频" : "音频";
}

// ---- 1.49.6 widget 隐藏机制（源码证据见报告） ----
// Vue 面板可见性：isWidgetVisible(mergedOptions) 读 options.hidden
// （useProcessedWidgets.ts；SafeWidgetData.options 来自
// extractWidgetDisplayOptions -> widget.options.hidden）。
// 画布绘制：LGraphCanvas.drawNodeWidgets -> LGraphNode.drawWidgets ->
// LGraphNode.isWidgetVisible 读 widget.hidden。
function mbSetHidden(w, hidden) {
  if (!w) return;
  if (hidden) {
    if (w.__mbOrigHidden === undefined) w.__mbOrigHidden = !!w.hidden;
    if (w.__mbOrigOptionsHidden === undefined) w.__mbOrigOptionsHidden = w.options?.hidden;
    w.hidden = true;
    if (w.options) w.options.hidden = true;
  } else {
    w.hidden = !!w.__mbOrigHidden;
    if (w.options) w.options.hidden = w.__mbOrigOptionsHidden;
  }
}

function mbRefreshWidgets(node) {
  node.widgets = node.widgets.slice();
  node.setDirtyCanvas?.(true, true);
}

function mbHeight(node) {
  const s = node.__mb;
  if (!s?.root) return 40;
  return (s.listEl.offsetHeight || 0) + (s.errorEl.offsetHeight || 0) + 8;
}

function mbRender(node) {
  const s = node.__mb;
  s.slots = mbSlots(s.items);
  s.listEl.innerHTML = "";
  s.items.forEach((it, idx) => s.listEl.appendChild(mbCard(node, it, idx)));
  s.listEl.appendChild(s.placeholderEl);
  mbRefreshError(node);
  mbResize(node);
}

function mbSyncFromWidget(node) {
  node.__mb.items = mbParse(node);
  mbRender(node);
}

function buildMediaBoard(node) {
  if (node.__mb) return;
  const state = {
    items: mbParse(node),
    errorText: "",
    slots: [],
    uploading: false,
    root: null,
    listEl: null,
    errorEl: null,
    placeholderEl: null,
  };
  node.__mb = state;

  // 隐藏序列化通道 widget。1.49.6 证据：type='hidden' 只会让 getComponent
  // 落空回退 WidgetLegacy（widgetRegistry），可见性根本不看 type；
  // 真正生效的是 widget.hidden（画布绘制/布局）与 widget.options.hidden（Vue 面板）。
  mbSetHidden(mbWidget(node, "media_list"), true);
  mbRefreshWidgets(node);

  const root = document.createElement("div");
  root.className = "mb-root";
  state.root = root;
  state.listEl = document.createElement("div");
  state.listEl.className = "mb-list";
  state.placeholderEl = mbPlaceholder(node);
  state.errorEl = document.createElement("div");
  state.errorEl.className = "mb-error";
  state.errorEl.style.display = "none";
  root.appendChild(state.listEl);
  root.appendChild(state.errorEl);

  mbRender(node);
  state.domWidget = node.addDOMWidget("h3_media_board", "h3_media_board", root, {
    serialize: false,
    getMinHeight: () => mbHeight(node),
    onDraw: () => mbHeight(node),
  });
  // spec 需求5：素材栏下方就是多行提示词编辑区。
  // addDOMWidget 会把 widget 追加到 node.widgets 末尾（渲染顺序：prompt 在上、素材栏在下），
  // 这里把素材栏 DOM widget 挪到 prompt widget 之前（模式同 ComfyUI-MiniMaxH3-Easy：
  // splice 取出后按重定位的 prompt 索引插回，prompt 随之 +1）。
  const domIndex = node.widgets?.indexOf(state.domWidget) ?? -1;
  const promptIndex = node.widgets?.findIndex((w) => w.name === "prompt") ?? -1;
  if (domIndex >= 0 && promptIndex >= 0 && domIndex !== promptIndex - 1) {
    node.widgets.splice(domIndex, 1);
    const promptNow = node.widgets.findIndex((w) => w.name === "prompt");
    node.widgets.splice(promptNow, 0, state.domWidget);
  }
  // 工作流加载时 widget 值可能在 onNodeCreated 之后才应用，补一次同步
  setTimeout(() => {
    if (node.__mb === state) mbSyncFromWidget(node);
  }, 100);
}

function mbInjectCss() {
  if (document.getElementById("mb-style")) return;
  const style = document.createElement("style");
  style.id = "mb-style";
  style.textContent = `
.mb-root { padding: 4px 0; }
.mb-list { display: flex; flex-wrap: wrap; gap: 6px; }
.mb-card { border: 1px solid #555; border-radius: 4px; background: #222; cursor: pointer; user-select: none; box-sizing: content-box; }
.mb-card.mb-missing { border-color: #f44; }
.mb-preview { position: relative; overflow: hidden; border-radius: 3px 3px 0 0; }
.mb-preview-img { width: 100%; height: 100%; object-fit: contain; background: #111; display: block; }
.mb-badge { position: absolute; left: 2px; top: 2px; background: rgba(255,200,0,.92); color: #000; font-size: 10px; line-height: 1.4; padding: 0 4px; border-radius: 2px; }
.mb-name { display: flex; align-items: center; background: #555; color: #fff; font-size: 11px; border-radius: 0 0 3px 3px; }
.mb-name-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 3px; }
.mb-name-btn { border: none; background: none; color: #fff; cursor: pointer; font-size: 13px; padding: 0 5px; }
.mb-name-btn:hover { color: #ffd000; }
.mb-placeholder { border: 2px dashed #888; display: flex; align-items: center; justify-content: center; background: #1a1a1a; }
.mb-plus { font-size: 40px; color: #888; }
.mb-audio-icon { font-size: 64px; color: #9bd; display: flex; align-items: center; justify-content: center; height: 100%; }
.mb-error { color: #f44; font-size: 12px; margin-top: 4px; }
.mb-error.mb-info { color: #aaa; }
.mb-play { position: absolute; left: 2px; bottom: 2px; background: rgba(0,0,0,.55); color: #fff; border: 1px solid #888; border-radius: 3px; font-size: 11px; line-height: 1.3; padding: 0 6px; cursor: pointer; z-index: 2; }
.mb-play:hover { border-color: #ffd000; }
.mb-time { position: absolute; right: 2px; bottom: 2px; background: rgba(0,0,0,.55); color: #fff; border-radius: 3px; font-size: 10px; line-height: 1.4; padding: 0 4px; z-index: 2; }
`;
  document.head.appendChild(style);
}

app.registerExtension({
  name: "H3MediaBoard",
  async beforeRegisterNodeDef(nodeType, nodeData, app) {
    if (nodeData.name !== "H3Ref2v_MediaTaskInput") return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      mbInjectCss();
      buildMediaBoard(this);
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const r = onConfigure?.apply(this, arguments);
      setTimeout(() => this.__mb && mbSyncFromWidget(this), 50);
      setTimeout(() => this.__mb && mbSyncFromWidget(this), 300);
      return r;
    };
  },
});

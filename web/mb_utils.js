// H3MediaBoard 纯函数工具层（ESM）。
// media_board.js 通过相对导入复用（ComfyUI 扩展以 ESM 加载，同类用法见
// ComfyUI-Easy-Use 前端的 ./xxx.js 相对导入）；本文件无 DOM 依赖，
// 由 tests/test_frontend_pure.mjs 在 Node 下直接验证。

export const KIND_OF = { image: "img", video: "video", audio: "audio" };
export const KIND_TAG = { image: "Picture", video: "Video", audio: "Audio" };

/**
 * 槽位角标：同类按显示顺序从 1 连续编号。
 * items: [{kind:"image|video|audio"}] -> [{badge:"img1"|"video2"|...}]
 */
export function mbSlots(items) {
  const counts = { image: 0, video: 0, audio: 0 };
  return items.map((it) => {
    counts[it.kind] += 1;
    return { badge: KIND_OF[it.kind] + counts[it.kind] };
  });
}

/**
 * 按标签引用从素材清单中收集被引用素材：tags=[{kind,n}]（mbParsePromptTags 输出，
 * 已去重），对照 items 同类按出现顺序计数（与媒体板角标一致），取第 n 个同 kind
 * 素材；n 超出该 kind 总数或 kind 非法则跳过；tags 重复（Set 兜底）只收集一次。
 * 返回 [{kind, n, path, name}]（保持 items 顺序；n 为同 kind 角标 = 被引用标签号，
 * 供优化器 label "picture n" 与后端按标签号过滤匹配）。
 */
export function mbCollectRefs(items, tags) {
  const valid = new Set((tags || []).map((t) => t.kind + ":" + t.n));
  const counts = { image: 0, video: 0, audio: 0 };
  const out = [];
  for (const it of items || []) {
    if (!it || typeof it.kind !== "string" || !valid.has(it.kind + ":" + (counts[it.kind] + 1))) {
      if (it && typeof it.kind === "string") counts[it.kind] = (counts[it.kind] || 0) + 1;
      continue;
    }
    counts[it.kind] = (counts[it.kind] || 0) + 1;
    out.push({ kind: it.kind, n: counts[it.kind], path: it.path, name: it.name });
  }
  return out;
}

/**
 * mm:ss 格式化。负数 / 非有限值 -> "--:--"；秒向下取整。
 */
export function mbFmtTime(t) {
  if (!isFinite(t) || t < 0) return "--:--";
  t = Math.floor(t);
  return (
    String(Math.floor(t / 60)).padStart(2, "0") +
    ":" +
    String(t % 60).padStart(2, "0")
  );
}

/**
 * 把 items[from] 移动到插入索引 insertIndex（0..length-1 的最终位置语义），
 * 返回新数组，不修改入参。from 越界时返回原数组副本。
 * 恒等性：insertIndex === from 时结果与原数组一致。
 */
export function mbReorder(items, from, insertIndex) {
  if (!Array.isArray(items) || from < 0 || from >= items.length) {
    return Array.isArray(items) ? items.slice() : [];
  }
  const arr = items.slice();
  const [it] = arr.splice(from, 1);
  const idx = Math.max(0, Math.min(arr.length, insertIndex));
  arr.splice(idx, 0, it);
  return arr;
}

/**
 * 拖拽命中测试：由“除被拖卡片外的其余卡片矩形”和指针坐标计算插入索引。
 *
 * rects: 其余卡片（显示顺序）的矩形数组 [{left, top, right, bottom}]。
 * 返回 0..rects.length 的插入索引（对 shouldRemove 后的数组直接适用）。
 *
 * 规则：
 *  1) 指针落在某卡片矩形内：左半 -> 插到它前面，右半 -> 插到它后面；
 *  2) 指针不在任何卡片内：按 flex 换行布局扫描 —— 整行在指针上方的卡片
 *     视为“在前”，整行在指针下方的第一张卡片处插入（= 上一行末尾），
 *     同一行内插到第一张中心点位于指针右侧的卡片之前；全部在左 -> 末尾。
 */
export function mbInsertIndex(rects, x, y) {
  // 1) 命中卡片
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
      return x < r.left + (r.right - r.left) / 2 ? i : i + 1;
    }
  }
  // 2) 未命中：按（行，x）扫描
  let insert = rects.length;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (y > r.bottom) continue; // 整行在指针上方 -> 指针之后
    const laterRow = y < r.top; // 整行在指针下方
    if (laterRow || r.left + (r.right - r.left) / 2 > x) {
      insert = i;
      break;
    }
    // 同一行且中心点在指针左侧 -> 继续扫描下一张
  }
  return insert;
}

/**
 * 标签拼装：{"kind":"image","badge":"img3"} -> "<Picture 3>"
 * （img->Picture、video->Video、audio->Audio，n = 角标号）
 */
export function mbMakeTag(item, badge) {
  const kind = KIND_OF[item?.kind];
  if (!kind || typeof badge !== "string" || !badge.startsWith(kind)) return "";
  return "<" + KIND_TAG[item.kind] + " " + badge.slice(kind.length) + ">";
}

const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "bmp", "gif"];
const VIDEO_EXTS = ["mp4", "mov", "webm", "mkv", "avi"];
const AUDIO_EXTS = ["mp3", "wav", "flac", "m4a", "ogg", "aac"];

/**
 * 按文件名扩展名识别素材类型：image | video | audio；未知/无扩展名 -> null。
 * 大小写不敏感；多段文件名取最后一段扩展名（"a.b.mp4" -> video）。
 */
export function mbDetectKind(name) {
  if (typeof name !== "string" || !name) return null;
  const i = name.lastIndexOf(".");
  if (i < 0) return null;
  const ext = name.slice(i + 1).toLowerCase();
  if (IMAGE_EXTS.includes(ext)) return "image";
  if (VIDEO_EXTS.includes(ext)) return "video";
  if (AUDIO_EXTS.includes(ext)) return "audio";
  return null;
}

const TAG_RE = /<(\s*)(picture|video|audio)\s+(\d{1,2})\s*>/gi;

/**
 * 解析提示词中的素材标签 <Picture n>/<Video n>/<Audio n>（大小写与空白宽容），
 * 返回按首次出现顺序去重的 [{kind, n}]；n 超出 1..32 视为非法（忽略）。
 * 供优化器 payload 收集（按标签引用）与任务判定复用。
 */
export function mbParsePromptTags(text) {
  if (typeof text !== "string" || !text) return [];
  const seen = new Set();
  const out = [];
  const kindOf = { picture: "image", video: "video", audio: "audio" };
  for (const m of text.matchAll(TAG_RE)) {
    const kind = kindOf[m[2].toLowerCase()];
    const n = Number(m[3]);
    if (!kind || n < 1 || n > 32) continue;
    const key = kind + ":" + n;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, n });
  }
  return out;
}

const PROMPT_TAG_GLOBAL_RE = /<(\s*)(picture|video|audio)\s+(\d{1,2})\s*>/gi;

/**
 * 把提示词文本分段为 [{type:"text"|"tag"}] 序列，供富文本编辑器渲染 chip：
 * 合法标签（n 1..32）独立成 tag 段（含 kind 与 n），其余全部并入 text 段
 * （顺序拼接所有段等于原文）。大小写与空白宽容（与 mbParsePromptTags 同规则）。
 */
export function mbSplitPromptSegments(text) {
  if (typeof text !== "string" || !text) return [];
  const out = [];
  let cursor = 0;
  const kindOf = { picture: "image", video: "video", audio: "audio" };
  for (const m of text.matchAll(PROMPT_TAG_GLOBAL_RE)) {
    const kind = kindOf[m[2].toLowerCase()];
    const n = Number(m[3]);
    if (!kind || n < 1 || n > 32) continue; // 非法标签整体留在文本段
    const start = m.index;
    const raw = m[0];
    if (start > cursor) out.push({ type: "text", text: text.slice(cursor, start) });
    out.push({ type: "tag", kind, n, raw });
    cursor = start + raw.length;
  }
  if (cursor < text.length) out.push({ type: "text", text: text.slice(cursor) });
  return out;
}

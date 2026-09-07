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

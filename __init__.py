import os
import json
import logging
import sys as _sys

import torch
import torchaudio.functional as F

import folder_paths
from comfy_api.latest import io

WEB_DIRECTORY = "./web"

# media_loader 与 __init__ 同目录，保证 ComfyUI 加载和独立测试都能导入
_PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
if _PLUGIN_DIR not in _sys.path:
    _sys.path.insert(0, _PLUGIN_DIR)
import media_loader

#==================== 0、Autogrow 级联输入辅助（参考 ComfyUI_RH_MinMaxH3 的实现方式）====================
# 组内输入全部为可选，min=0 表示默认只显示第 1 个输入；
# 第 1 个连接后才显示第 2 个，依次类推，断开连接会自动收起多余行。

IMG_NAMES = [f"img{i}" for i in range(1, 10)]                  # img1..img9
VIDEO_NAMES = [f"video{i}" for i in range(1, 4)]               # video1..video3
AUDIO_NAMES = [f"audio{i}" for i in range(1, 4)]               # audio1..audio3
VIDEO_AUDIO_NAMES = [f"video_audio{i}" for i in range(1, 4)]   # video_audio1..video_audio3
ITEM_NAMES = [f"item{i}" for i in range(1, 33)]                # item1..item32
LIST_NAMES = [f"list{i}" for i in range(1, 17)]                # list1..list16

TUPLE_IO = io.Custom("TUPLE")
LIST_IO = io.Custom("LIST")


def _grow_group(group_id, type_io, names):
    """Autogrow 分组：默认只显示第 1 个输入，连接后才依次显示下一个。"""
    return io.Autogrow.Input(
        group_id,
        template=io.Autogrow.TemplateNames(
            input=type_io.Input(names[0], optional=True),
            names=names,
            min=0,
        ),
    )


def _media_groups():
    """3 个任务输入节点共用的媒体输入组。"""
    return [
        _grow_group("images", io.Image, IMG_NAMES),
        _grow_group("videos", io.Image, VIDEO_NAMES),
        _grow_group("audios", io.Audio, AUDIO_NAMES),
        _grow_group("video_audios", io.Audio, VIDEO_AUDIO_NAMES),
    ]


def _task_inputs():
    """3 个任务输入节点共用的输入面板（和原版 InputItem 一致）。"""
    return [
        io.Int.Input("duration", default=5, min=1, max=60, step=1),
        *_media_groups(),
        io.String.Input("prompt", default="", multiline=True, optional=True),
    ]


def _group_values(group, names):
    """Autogrow 分组 dict -> 按声明顺序的值列表（未连接为 None）。"""
    if isinstance(group, dict):
        return [group.get(n) for n in names]
    return [None] * len(names)


def _pack_task(duration, images, videos, audios, video_audios, prompt):
    """按原版顺序打包 20 元组（9图+3视频+3音频+3视频音频+prompt+duration）。"""
    return (
        *_group_values(images, IMG_NAMES),
        *_group_values(videos, VIDEO_NAMES),
        *_group_values(audios, AUDIO_NAMES),
        *_group_values(video_audios, VIDEO_AUDIO_NAMES),
        prompt, duration,
    )

#==================== 1、原版独立 InputItem（输入面板和原版一致，分散输出）====================
class H3Ref2v_InputItem(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="H3Ref2v_InputItem",
            display_name="H3｜单段任务输入(分散输出)",
            category="H3Ref2v/TaskInput",
            inputs=_task_inputs(),
            outputs=[
                io.Image.Output(display_name="img_out1"),
                io.Image.Output(display_name="img_out2"),
                io.Image.Output(display_name="img_out3"),
                io.Image.Output(display_name="img_out4"),
                io.Image.Output(display_name="img_out5"),
                io.Image.Output(display_name="img_out6"),
                io.Image.Output(display_name="img_out7"),
                io.Image.Output(display_name="img_out8"),
                io.Image.Output(display_name="img_out9"),
                io.Image.Output(display_name="vid_out1"),
                io.Image.Output(display_name="vid_out2"),
                io.Image.Output(display_name="vid_out3"),
                io.Audio.Output(display_name="aud_out1"),
                io.Audio.Output(display_name="aud_out2"),
                io.Audio.Output(display_name="aud_out3"),
                io.Audio.Output(display_name="vid_aud_out1"),
                io.Audio.Output(display_name="vid_aud_out2"),
                io.Audio.Output(display_name="vid_aud_out3"),
                io.String.Output(display_name="prompt_out"),
                io.Int.Output(display_name="duration_out"),
            ],
        )

    @classmethod
    def execute(cls, duration=5, images=None, videos=None, audios=None, video_audios=None, prompt=""):
        imgs = _group_values(images, IMG_NAMES)
        vids = _group_values(videos, VIDEO_NAMES)
        auds = _group_values(audios, AUDIO_NAMES)
        vid_auds = _group_values(video_audios, VIDEO_AUDIO_NAMES)
        return io.NodeOutput(*imgs, *vids, *auds, *vid_auds, prompt, duration)

#==================== 2、原版独立 TaskPacker ====================
class H3Ref2v_TaskPacker(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="H3Ref2v_TaskPacker",
            display_name="H3｜任务打包器(接收分散端口打包)",
            category="H3Ref2v/Helper",
            inputs=_task_inputs(),
            outputs=[TUPLE_IO.Output(display_name="task_tuple")],
        )

    @classmethod
    def execute(cls, duration=5, images=None, videos=None, audios=None, video_audios=None, prompt=""):
        return io.NodeOutput(_pack_task(duration, images, videos, audios, video_audios, prompt))

#==================== 3、【一体化结合体节点】输入面板和InputItem完全一致，直接输出打包Tuple====================
class H3Ref2v_IntegratedTaskInput(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="H3Ref2v_IntegratedTaskInput",
            display_name="H3｜一体化任务输入(直接输出Tuple包)",
            category="H3Ref2v/TaskInput",
            inputs=_task_inputs(),
            outputs=[TUPLE_IO.Output(display_name="task_tuple")],
        )

    @classmethod
    def execute(cls, duration=5, images=None, videos=None, audios=None, video_audios=None, prompt=""):
        return io.NodeOutput(_pack_task(duration, images, videos, audios, video_audios, prompt))

#==================== 4、32路收集器====================
class H3Ref2v_LoopCollector(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="H3Ref2v_LoopCollector",
            display_name="H3｜循环任务汇总收集器[32路，可链式无限扩容]",
            category="H3Ref2v/Loop",
            inputs=[_grow_group("items", TUPLE_IO, ITEM_NAMES)],
            outputs=[
                LIST_IO.Output(display_name="task_list"),
                io.Int.Output(display_name="task_count"),
            ],
        )

    @classmethod
    def execute(cls, items=None):
        task_list = []
        if isinstance(items, dict):
            for name in ITEM_NAMES:
                task_tuple = items.get(name)
                if task_tuple is not None and isinstance(task_tuple, tuple):
                    task_list.append(task_tuple)
        return io.NodeOutput(task_list, len(task_list))

#==================== 5、多列表合并中转节点（链式无限扩容）====================
class H3Ref2v_ListCollectorJoin(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="H3Ref2v_ListCollectorJoin",
            display_name="H3｜多列表合并中转【链式无限扩容】",
            category="H3Ref2v/Loop",
            inputs=[_grow_group("lists", LIST_IO, LIST_NAMES)],
            outputs=[
                LIST_IO.Output(display_name="merged_total_list"),
                io.Int.Output(display_name="total_task_count"),
            ],
        )

    @classmethod
    def execute(cls, lists=None):
        total = []
        last_len = 0  # 保持原版行为：计数取最后一段有效列表的长度（无连接时为 0）
        if isinstance(lists, dict):
            for name in LIST_NAMES:
                lst = lists.get(name)
                if isinstance(lst, list) and len(lst) > 0:
                    total.extend(lst)
                    last_len = len(lst)
        return io.NodeOutput(total, last_len)

#====================6、列表无限合并器====================
class H3Ref2v_ListMerger:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "target_audio_sample_rate": ("INT", {"default": 32000, "min":8000,"max":96000,"step":100}),
            },
            "optional": {
                "image_list": ("LIST",),
                "audio_list": ("LIST",),
            }
        }
    RETURN_TYPES = ("IMAGE","AUDIO","INT")
    RETURN_NAMES = ("merged_video_frames","merged_audio","valid_segments")
    FUNCTION = "merge_list"
    CATEGORY = "H3Ref2v/Merge"
    def merge_list(self,target_audio_sample_rate,image_list=None,audio_list=None):
        video_batch=[]
        if image_list is not None and isinstance(image_list,list):
            for frame_data in image_list:
                if frame_data is None:
                    continue
                if isinstance(frame_data,torch.Tensor) and frame_data.numel()>0:
                    video_batch.append(frame_data)
        final_video=torch.cat(video_batch,dim=0) if len(video_batch)>0 else None

        audio_waves=[]
        if audio_list is not None and isinstance(audio_list,list):
            for aud in audio_list:
                if aud is None:
                    continue
                if isinstance(aud,dict) and "waveform" in aud and "sample_rate" in aud:
                    wf=aud["waveform"]
                    sr_in=aud["sample_rate"]
                    if wf.numel()>0:
                        if sr_in != target_audio_sample_rate:
                            wf=F.resample(wf,orig_freq=sr_in,new_freq=target_audio_sample_rate)
                        audio_waves.append(wf)
        final_audio=None
        if len(audio_waves)>0:
            wave_cat=torch.cat(audio_waves,dim=-1)
            final_audio={"waveform":wave_cat,"sample_rate":target_audio_sample_rate}
        valid_num=max(len(video_batch),len(audio_waves))
        return (final_video,final_audio,valid_num)

class H3Ref2v_TupleUnpack:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "task_tuple": ("TUPLE",),
            }
        }
    RETURN_TYPES = (
        "IMAGE","IMAGE","IMAGE","IMAGE","IMAGE","IMAGE","IMAGE","IMAGE","IMAGE",
        "IMAGE","IMAGE","IMAGE",
        "AUDIO","AUDIO","AUDIO",
        "AUDIO","AUDIO","AUDIO",
        "STRING","INT"
    )
    RETURN_NAMES = (
        "img1","img2","img3","img4","img5","img6","img7","img8","img9",
        "video1","video2","video3",
        "audio1","audio2","audio3",
        "video_audio1","video_audio2","video_audio3",
        "prompt","duration"
    )
    FUNCTION = "unpack"
    CATEGORY = "H3Ref2v/Helper"
    def unpack(self,task_tuple):
        data = list(task_tuple)
        #不足21项自动补None，防止索引报错
        while len(data)<21:
            data.append(None)
        return tuple(data)

class H3Ref2v_GetItemByIndex:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "input_list": ("LIST",),
                "index": ("INT",),
            }
        }
    RETURN_TYPES = ("TUPLE",)
    RETURN_NAMES = ("task_tuple",)
    FUNCTION = "get_item"
    CATEGORY = "H3Ref2v/Helper"
    def get_item(self,input_list,index):
        if 0<=index<len(input_list):
            return (input_list[index],)
        else:
            return (None,)

class H3Ref2v_CreateEmptyList:
    @classmethod
    def INPUT_TYPES(s):
        return {"required": {}}
    RETURN_TYPES = ("LIST",)
    RETURN_NAMES = ("empty_list",)
    FUNCTION = "create"
    CATEGORY = "H3Ref2v/Helper"
    def create(self):
        return ([],)

class H3Ref2v_AppendToList:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "input_list": ("LIST",),
                "item": ("*",),
            }
        }
    RETURN_TYPES = ("LIST",)
    RETURN_NAMES = ("new_list",)
    FUNCTION = "append"
    CATEGORY = "H3Ref2v/Helper"
    def append(self,input_list,item):
        new_list = input_list.copy()
        new_list.append(item)
        return (new_list,)

#==================== 10、媒体板任务输入（面板选材直出Tuple包，替代 加载图像/视频/音频 三节点连线）====================
def _resolve_media_path(path):
    """annotated 相对路径（"name" / "subfolder/name"）按 spec 4.2 解析到 input 目录；
    绝对路径原样返回（独立测试与兜底使用），目录逃逸抛 ValueError 由调用方跳过。"""
    if os.path.isabs(path):
        return path
    return folder_paths.get_annotated_filepath(path)


def _pack_media_task(media_list, prompt, duration):
    """按显示顺序打包 20 元组（9图+3视频+3音频+3视频音轨+prompt+duration）。

    单个素材解码失败只跳过该槽位并警告，不拖垮整个节点。
    """
    imgs = [None] * 9
    vids = [None] * 3
    auds = [None] * 3
    vid_auds = [None] * 3
    i = j = k = 0
    for item in media_list:
        kind = item.get("kind") if isinstance(item, dict) else None
        path = item.get("path") if isinstance(item, dict) else None
        if not path:
            continue
        try:
            path = _resolve_media_path(path)
            if kind == "image" and i < 9:
                imgs[i] = media_loader.load_media_image(path)
                i += 1
            elif kind == "video" and j < 3:
                vids[j], vid_auds[j] = media_loader.load_media_video(path)
                j += 1
            elif kind == "audio" and k < 3:
                auds[k] = media_loader.load_media_audio(path)
                k += 1
        except Exception as e:
            logging.warning("[H3MediaBoard] 跳过无法加载的素材 %s: %s", path, e)
    return (*imgs, *vids, *auds, *vid_auds, prompt, duration)


class H3Ref2v_MediaTaskInput(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        # 选材由前端系统文件选择器完成（上传到 input 目录后写入 media_list），
        # 因此 schema 不再需要 pick_* combo——这同时从根上消除了
        # uploadImage 扩展自动追加的 "Choose file to upload" 按钮。
        return io.Schema(
            node_id="H3Ref2v_MediaTaskInput",
            display_name="H3｜媒体板任务输入(选材直出Tuple包)",
            category="H3Ref2v/TaskInput",
            inputs=[
                io.Int.Input("duration", default=5, min=1, max=60, step=1),
                io.String.Input("media_list", default="[]", socketless=True),
                io.String.Input("prompt", default="", multiline=True, optional=True),
            ],
            outputs=[TUPLE_IO.Output(display_name="tuple_item")],
        )

    @classmethod
    def execute(cls, duration=5, media_list="[]", prompt=""):
        try:
            items = json.loads(media_list) if media_list else []
        except (ValueError, TypeError):
            logging.warning("[H3MediaBoard] media_list JSON 损坏，按空清单处理")
            items = []
        return io.NodeOutput(_pack_media_task(items, prompt, duration))

#====================注册全部节点====================
NODE_CLASS_MAPPINGS = {
    "H3Ref2v_InputItem":H3Ref2v_InputItem,
    "H3Ref2v_TaskPacker":H3Ref2v_TaskPacker,
    "H3Ref2v_IntegratedTaskInput":H3Ref2v_IntegratedTaskInput,
    "H3Ref2v_LoopCollector":H3Ref2v_LoopCollector,
    "H3Ref2v_ListCollectorJoin":H3Ref2v_ListCollectorJoin,
    "H3Ref2v_ListMerger":H3Ref2v_ListMerger,
    "H3Ref2v_TupleUnpack":H3Ref2v_TupleUnpack, #新增
    "H3Ref2v_GetItemByIndex":H3Ref2v_GetItemByIndex, #新增
    "H3Ref2v_CreateEmptyList":H3Ref2v_CreateEmptyList, #新增
    "H3Ref2v_AppendToList":H3Ref2v_AppendToList, #新增
    "H3Ref2v_MediaTaskInput":H3Ref2v_MediaTaskInput, #新增：媒体板
}
NODE_DISPLAY_NAME_MAPPINGS={
    "H3Ref2v_InputItem":"H3｜单段任务输入(分散输出)",
    "H3Ref2v_TaskPacker":"H3｜任务打包器(接收分散端口打包)",
    "H3Ref2v_IntegratedTaskInput":"H3｜一体化任务输入(直接输出Tuple包)",
    "H3Ref2v_LoopCollector":"H3｜循环任务汇总收集器[32路，可链式无限扩容]",
    "H3Ref2v_ListCollectorJoin":"H3｜多列表合并中转【链式无限扩容】",
    "H3Ref2v_ListMerger":"H3｜列表无限合并器(适配was_loop输出LIST)",
    "H3Ref2v_TupleUnpack":"H3｜元组解包(拆分loop_item)",#新增
    "H3Ref2v_GetItemByIndex":"H3｜按索引读取列表元素节点",#新增
    "H3Ref2v_CreateEmptyList":"H3｜创建空List",#新增
    "H3Ref2v_AppendToList":"H3｜追加List元素",#新增
    "H3Ref2v_MediaTaskInput":"H3｜媒体板任务输入(选材直出Tuple包)",#新增：媒体板
}

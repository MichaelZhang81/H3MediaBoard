"""H3MediaBoard 媒体解码层 —— 全部基于 ComfyUI 官方加载路径（InputImpl/av/PIL），零新增依赖。

本机环境注意：torchaudio.load 不可用（缺 torchcodec/soundfile），一律禁止使用；
ComfyUI 0.33.1 核心自身用 av 解码（comfy_extras/nodes_audio.py:333）。
"""
import torch
import av
import numpy as np
from PIL import Image as PILImage
from PIL import ImageOps

from comfy_api.latest import InputImpl


def _f32_pcm(wav: torch.Tensor) -> torch.Tensor:
    """与核心 comfy_extras/nodes_audio.py 的 f32_pcm 相同：按样本格式归一化到 float32。"""
    if wav.dtype == torch.float32:
        return wav
    elif wav.dtype == torch.int16:
        return wav.float() / (2 ** 15)
    elif wav.dtype == torch.int32:
        return wav.float() / (2 ** 31)
    raise ValueError(f"Unsupported wav dtype: {wav.dtype}")


def _pil_fallback(path: str) -> torch.Tensor:
    """pyav 不支持的静态图（如动画 webp）回退 PIL，与官方 LoadImage 兜底逻辑一致。"""
    img = PILImage.open(path)
    img = ImageOps.exif_transpose(img).convert("RGB")
    return torch.from_numpy(np.array(img).astype(np.float32) / 255.0).unsqueeze(0)


def load_media_image(path: str) -> torch.Tensor:
    """图片 -> [N,H,W,C] float32 张量（0-1）。官方 LoadImage 同款加载路径。"""
    components = InputImpl.VideoFromFile(path).get_components()
    if components.images is not None and components.images.shape[0] > 0:
        return components.images
    return _pil_fallback(path)


def load_media_video(path: str):
    """视频 -> (frames[N,H,W,C] float32, audio_dict|None)，一次解码取帧+音轨。

    audio_dict 为官方 AUDIO 格式：{"waveform": [1,C,T] float32, "sample_rate": int}；
    视频无音轨时为 None。
    """
    components = InputImpl.VideoFromFile(path).get_components()
    frames = (
        components.images
        if components.images is not None and components.images.shape[0] > 0
        else None
    )
    return frames, (components.audio or None)


def load_media_audio(path: str) -> dict:
    """音频文件 -> {"waveform": [1,C,T] float32, "sample_rate": int}。

    照抄核心 LoadAudio.load（comfy_extras/nodes_audio.py:333），末尾 unsqueeze(0)
    与核心 LoadAudio 输出 [1,C,T] 保持一致。
    """
    with av.open(path) as af:
        if not af.streams.audio:
            raise ValueError("No audio stream found in the file.")
        stream = af.streams.audio[0]
        sr = stream.codec_context.sample_rate
        n_channels = stream.channels
        frames = []
        for frame in af.decode(streams=stream.index):
            buf = torch.from_numpy(frame.to_ndarray())
            if buf.shape[0] != n_channels:
                buf = buf.view(-1, n_channels).t()
            frames.append(buf)
        if not frames:
            raise ValueError("No audio frames decoded.")
    wav = torch.cat(frames, dim=1)
    wav = _f32_pcm(wav)
    return {"waveform": wav.unsqueeze(0), "sample_rate": sr}

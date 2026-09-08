# H3MediaBoard
An advanced collection of helper custom nodes to simplify video generation workflows for Minimax‑H3.

## 📦 Installation
Clone this repository into ComfyUI's custom_nodes folder:

```
cd ComfyUI/custom_nodes
git clone https://github.com/MichaelZhang81/H3MediaBoard.git
```
Required dependencies (torch, einops, safetensors) are already present in a standard ComfyUI environment — no extra install needed.

Restart ComfyUI.

## NODE_DISPLAY_NAME

- H3｜单段任务输入(分散输出)
- H3｜任务打包器(接收分散端口打包)
- H3｜一体化任务输入(直接输出Tuple包)
- H3｜循环任务汇总收集器[32路，可链式无限扩容]
- H3｜多列表合并中转【链式无限扩容】
- H3｜列表无限合并器(适配was_loop输出LIST)
- H3｜元组解包(拆分loop_item)
- H3｜按索引读取列表元素节点
- H3｜创建空List
- H3｜追加List元素
- H3｜媒体板任务输入(选材直出Tuple包)
- H3｜高级媒体板任务输入(选材直出Tuple包)

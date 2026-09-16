# Hunyuan3D 本地最高质量部署任务书

## 目标

在用户 Windows 主机上，以“RTX 4070 Ti 12GB + 64GB RAM 条件下可实际稳定运行的最高质量”为目标，完成腾讯混元 3D 本地生成栈部署、真实推理验证和一键启动交付。

不是只把依赖装上，也不是为了省显存主动退回 mini。最终必须真实生成可读取的 3D 文件。

## 执行规则

先读取：

1. 仓库根目录 `AGENTS.md`（如存在）
2. `https://github.com/zcssr1998-art/AI-Development-Rules/blob/main/GLOBAL_AI_RULES.md`
3. 本任务书

遵循：已有成熟方案 > 修改成熟方案 > 自行新写。只做完成目标所需的最低复杂度改动。普通安装/依赖/CUDA/OOM 问题自行诊断和修复，不要把常规技术选择抛回给用户。

只有付费、缺失必须授权、明显不可逆/数据丢失风险或确认无法绕过的硬件阻塞才中断。

## 已知机器

- OS：Windows
- CPU：Ryzen 7 7700X
- GPU：RTX 4070 Ti 12GB
- RAM：64GB
- Python：已有 3.10.8
- Blender：`D:\CG tool\blend\blender.exe`
- 安装根目录：`D:\AI3dmodel\Hunyuan3D`
- `D:\AI3dmodel` 下可能已有 Pixal3D 等其他项目，严禁破坏/覆盖其环境。

## 模型目标

### 1. 主力单图 Shape

部署腾讯官方 **Hunyuan3D 2.1 Full Shape（3.3B）**，作为默认单图 → 3D Geometry 高质量模型。

要求：

- 优先完整模型，不主动换 mini/turbo。
- 默认使用官方已验证的 FP16/BF16 路线；除非实测硬性需要，不做量化。
- Shape 模型单独占用 GPU，不与 Paint 常驻同一进程。

### 2. 多视图 Shape

部署腾讯官方 **Hunyuan3D-2mv Full / Standard 非 Turbo**，用于多视图设定图 → 3D。

目标输入包括正面、侧面、背面、3/4 等多角度参考。Turbo/Fast 只作为备用模式，不能替代默认最高质量模式。

### 3. Texture / Paint

部署 **Hunyuan3D Paint 2.1**。

12GB VRAM 不允许直接按高显存默认方案硬顶。优先复用成熟低显存实现（如 MMGP / Hunyuan3D-2GP 一类已验证 offload 方案），利用 64GB RAM 做 CPU offload / staged loading。

默认先以：

- texture resolution 512
- 6 views（如实际方案需要可按稳定性最小调整）
- CPU/GPU staged loading
- VAE slicing / low-VRAM 选项（如实现支持）

完成一次稳定完整纹理生成。768 可在核心验收完成后尝试，但不得阻塞本任务。

### 4. 可选 Omni

只有核心 Shape + MultiView + Paint 已全部通过后，且磁盘空间充足，才允许增加 Hunyuan3D-Omni 作为 pose/voxel/point/bbox 控制扩展。

Omni 不是核心任务，不得拖延交付。

## 安装约束

- 原生 Windows 优先。
- 不主动引入 WSL/Docker/VM；只有原生 Windows 被明确验证为硬阻塞时才考虑。
- Hunyuan 使用独立 Python 环境，禁止污染全局 Python。
- 不修改其他 AI 项目 venv。
- 不无理由重装 NVIDIA 驱动或系统 CUDA。
- 依赖版本优先官方已验证组合，不为追新升级整棵依赖树。
- 模型权重优先腾讯官方 GitHub/Hugging Face；需要镜像时必须保证来源可信、可断点续传、避免重复下载。
- 相同权重尽量只保存一份，通过 Hugging Face cache/路径配置复用。

## 目录与交付

安装根目录：

`D:\AI3dmodel\Hunyuan3D`

至少交付：

- `start_shape_best.bat`
- `start_multiview_best.bat`
- `start_texture_lowvram.bat`
- `doctor.bat`
- `README_LOCAL.md`
- `outputs\`
- `logs\`

可选：

- `start_api.bat`，默认仅绑定 `127.0.0.1`

不要为本任务开发复杂 GUI、Electron Launcher 或自研显存管理器。

## 安装前最小检查

只检查必要项：

```bat
nvidia-smi
python --version
git --version
git lfs version
```

并在目标 venv 中真实确认：

```python
import torch
print(torch.__version__)
print(torch.version.cuda)
print(torch.cuda.is_available())
print(torch.cuda.get_device_name(0))
print(torch.cuda.get_device_properties(0).total_memory)
```

必须确认 PyTorch 真正使用 RTX 4070 Ti CUDA。

遇到 CUDA extension / rasterizer 编译问题时，按最小范围依次核对 MSVC、Windows SDK、`cl.exe`、`rc.exe`、Ninja/CMake、PyTorch CUDA ABI 与 PATH；只补缺失项，不重装整套环境。

## 显存策略

不要让 Shape + Paint 同时常驻 GPU。

正确流水线：

```text
Shape / MultiView
→ 保存 mesh
→ 卸载模型并释放 GPU
→ Paint
→ CPU RAM ↔ GPU 分阶段加载
→ 输出 textured GLB
```

64GB RAM 应用于 offload/staging，不因为 12GB VRAM 就直接降级到 0.6B/mini 主模型。

## 一键启动要求

### `start_shape_best.bat`

- 启动 Hunyuan3D 2.1 Full Shape
- 默认 Full 3.3B
- 非 mini / 非 turbo
- 不默认常驻 Paint

### `start_multiview_best.bat`

- 启动 Hunyuan3D-2mv Full
- 默认非 Turbo/Fast

### `start_texture_lowvram.bat`

- 启动 Paint 2.1 低显存方案
- 默认 512 texture
- 使用成熟 CPU offload / staged loading
- 目标是 12GB VRAM 下完成一次真实纹理生成

### `doctor.bat`

至少输出：

```text
CUDA: PASS/FAIL
Shape: PASS/FAIL
MultiView: PASS/FAIL
Texture: PASS/FAIL
```

并给出 Python/Torch/CUDA/GPU/VRAM/RAM/关键模型文件与核心 import 状态。

## 真实验收

### A. Full Shape

使用官方 demo 或可靠测试图真实运行 Hunyuan3D 2.1 Full Shape，生成：

`outputs\test_shape.glb`

必须验证：

- 文件存在且非空
- trimesh 或等价工具能读取
- vertex > 0
- face > 0
- 无 NaN/Inf 导致的损坏

记录关键耗时、峰值 VRAM/RAM 即可，不做无意义 benchmark。

### B. MultiView

使用官方 Hunyuan3D-2mv example 真实运行，生成：

`outputs\test_multiview.glb`

验证 mesh 可读取、顶点/面正常、进程无崩溃。

### C. Texture

使用已经生成的 mesh，通过低显存 Paint Pipeline 真实生成：

`outputs\test_textured.glb`

先按 512 / 低显存策略执行。

如 OOM，按以下顺序 focused repair：

1. 清理无关 GPU 进程
2. 确认 Shape 已卸载
3. 清理 CUDA cache
4. 启用/加强成熟 offload
5. VAE slicing / staged loading
6. 必要时减少 view，但保持 512 作为首要稳定目标

不要因为 Paint OOM 就替换 Full Shape 主模型。

### D. Blender Smoke

用：

`D:\CG tool\blend\blender.exe`

background 模式导入最终 `test_textured.glb`，检查：

- object 存在
- mesh 存在
- material 存在
- Blender 正常 exit 0

不做额外建模。

### E. 冷启动

关闭相关进程后，至少重新启动一次核心 launcher，确认不是只在安装 session 中偶然可用。

## 完成标准

核心任务只有全部满足才可 `PASS`：

- [ ] PyTorch CUDA 正确识别 RTX 4070 Ti
- [ ] Hunyuan3D 2.1 Full Shape 安装并完成真实推理
- [ ] `test_shape.glb` 有效
- [ ] Hunyuan3D-2mv Full 安装并完成真实推理
- [ ] `test_multiview.glb` 有效
- [ ] Paint 2.1 低显存路线安装并完成真实纹理推理
- [ ] `test_textured.glb` 有效
- [ ] Blender 或 trimesh 真实打开最终 GLB
- [ ] 三个 BAT 可独立启动
- [ ] 冷启动复测通过
- [ ] 未破坏 Pixal3D/其他现有 AI 环境

如果 Shape + MultiView 通过，但 Paint 在成熟 offload + focused repair 后仍因硬件限制无法完成，可报 `PARTIAL PASS`，但必须记录真实失败证据、峰值 VRAM、已尝试的 offload 路径和关键 blocker。禁止把“理论可跑”写成 PASS。

## README_LOCAL

只写用户实际需要的内容：

- 单图：双击哪个 BAT
- 多视图：双击哪个 BAT
- 纹理：双击哪个 BAT
- 输入/输出目录
- 哪个是最高质量模式
- 哪个是备用快速模式（如存在）
- 12GB VRAM 的实际限制与 OOM 时先关闭哪些 GPU 程序

不要写成长篇技术文档。

## 不做

- 不安装大量无关 AI 3D 模型
- 不重构 Pixal3D
- 不改 Blender
- 不开发复杂统一 GUI
- 不从零写显存管理
- 不扫描整个硬盘
- 不下载全部 Hunyuan 历史模型
- 不保留多份重复权重
- 不跑大量无意义测试
- 验收通过后立即停止，不做顺手重构/额外优化

## 最终回报

详细安装日志和证据留在本地项目目录/仓库，不要把长日志发 Discord。

只返回：

```text
PASS / PARTIAL PASS / FAIL

Shape: Hunyuan3D 2.1 Full - PASS/FAIL
MultiView: Hunyuan3D-2mv Full - PASS/FAIL
Texture: Hunyuan3D Paint 2.1 LowVRAM - PASS/FAIL
GPU: RTX 4070 Ti 12GB
tests: <最关键的真实生成/冷启动结果>
launchers: D:\AI3dmodel\Hunyuan3D\...
output: D:\AI3dmodel\Hunyuan3D\outputs
blocker: none / <唯一关键阻塞>
```

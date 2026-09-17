# Active task

`docs/tasks/HUNYUAN3D_LOCAL_REPAIR_AND_SMOKE.md` — repair the existing local Hunyuan3D 2.1 installation under `D:\Hunyuan3d`, fill only the real dependency/runtime gaps, then prove the WebUI and a minimal real generation path work on the Windows machine.

## Known starting point

- target app tree: `D:\Hunyuan3d\repo21`
- existing venv: `D:\Hunyuan3d\venv`
- current observed launch blocker: `ModuleNotFoundError: No module named 'gradio'`
- preserve existing model caches, local compatibility patches, and the working Torch/CUDA stack unless evidence proves they are the blocker

## Required closeout

Do not report PASS from code inspection or package installation alone. The task requires a real WebUI startup, local reachability, one minimal real shape-generation smoke, explicit texture-path status, and a tested one-click launcher at `D:\Hunyuan3d\start_hunyuan3d_2_1.bat`.

## Previous task

`docs/tasks/CHAT_TIMEOUT_UNLIMITED_FIX.md` — implemented and verified before this task became active.

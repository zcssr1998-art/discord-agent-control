# Hunyuan3D 2.1 local repair + real smoke task

## Objective

Repair the existing local Hunyuan3D installation under `D:\Hunyuan3d` with the **minimum necessary changes**, then prove that the Hunyuan3D 2.1 WebUI actually starts and can execute the core generation path on this Windows machine.

Do **not** reinstall from scratch unless the existing installation is genuinely unrecoverable.

## Known current state / evidence

The owner already verified:

- root: `D:\Hunyuan3d`
- virtualenv exists: `D:\Hunyuan3d\venv`
- Hunyuan3D 2.0 repo exists: `D:\Hunyuan3d\repo20`
- Hunyuan3D 2.1 repo exists: `D:\Hunyuan3d\repo21`
- `gradio_app.py` exists in both repos
- target repo for this task: `D:\Hunyuan3d\repo21`
- Python launches from the venv
- Torch/Torchvision load far enough to report `torchvision 0.20.1+cu124`
- repo21 applies a `torchvision.transforms.functional_tensor` compatibility shim at startup
- current deterministic failure when launching repo21:

```text
ModuleNotFoundError: No module named 'gradio'
```

The failed command was:

```bat
D:\Hunyuan3d\venv\Scripts\python.exe gradio_app.py --model_path tencent/Hunyuan3D-2.1 --subfolder hunyuan3d-dit-v2-1 --low_vram_mode
```

Do not waste time rediscovering these facts unless current disk state contradicts them.

## Operating rules

1. Read project `AGENTS.md` and the central `GLOBAL_AI_RULES.md` first.
2. Treat `D:\Hunyuan3d\repo21` as the canonical 2.1 application tree for this repair.
3. Preserve existing model weights/caches/downloads and working compatibility patches.
4. Do not modify global/system Python. Use only `D:\Hunyuan3d\venv` unless there is a hard technical reason not to.
5. Do not blindly `git reset`, overwrite local patches, delete caches, or reclone.
6. Do not upgrade to arbitrary latest package versions. Compare against the **official Tencent Hunyuan3D-2.1 requirements / README** and preserve a compatible Torch/CUDA stack.
7. Diagnose from deterministic evidence: package inventory/import probes/failed stack traces. Avoid broad speculative environment changes.
8. Retry only after a concrete repair. Stop when acceptance criteria pass.
9. Never expose or commit credentials/tokens.

Official upstream reference:

- repo: `Tencent-Hunyuan/Hunyuan3D-2.1`
- official `requirements.txt` currently pins the demo stack including `gradio==5.33.0`, `fastapi==0.115.12`, `uvicorn==0.34.3` plus the model/3D dependencies.
- upstream README documents `--low_vram_mode` and the Hunyuan3D-2.1 model/subfolder launch path.

## Phase 1 — focused installation audit

From `D:\Hunyuan3d\repo21`, inspect only what is necessary:

### A. Repository / launcher state

Record:

```bat
cd /d D:\Hunyuan3d\repo21
git status --short
git rev-parse --short HEAD
```

If this tree is not a Git repo, note that and continue; it is not itself a blocker.

Check whether there are local edits/compatibility shims. Preserve them unless they are proven to cause the failure.

### B. Runtime identity

Use exactly:

```bat
D:\Hunyuan3d\venv\Scripts\python.exe --version
D:\Hunyuan3d\venv\Scripts\python.exe -m pip --version
```

Confirm the interpreter/pip both resolve inside the intended venv.

### C. GPU/Torch sanity

Run a small probe and capture only the useful result:

```bat
D:\Hunyuan3d\venv\Scripts\python.exe -c "import torch, torchvision; print('torch', torch.__version__); print('torchvision', torchvision.__version__); print('cuda', torch.cuda.is_available()); print('cuda_version', torch.version.cuda); print('gpu', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'NONE')"
```

Expected hardware is an NVIDIA RTX 4070 Ti 12 GB. Do not replace a working CUDA/Torch stack merely because a newer one exists.

### D. Dependency gap analysis

Compare the current venv against `D:\Hunyuan3d\repo21\requirements.txt` and the current official Tencent upstream requirements.

Use targeted checks such as:

```bat
D:\Hunyuan3d\venv\Scripts\python.exe -m pip check
D:\Hunyuan3d\venv\Scripts\python.exe -m pip show gradio fastapi uvicorn
```

If useful, make a small script/probe that attempts imports required by `gradio_app.py` and reports only missing/broken modules.

Do not dump a giant full `pip list` into the model context unless necessary.

## Phase 2 — minimal repair

Repair the actual missing/broken dependencies.

Preferred order:

1. If the environment is mostly complete and only a small set is missing, install only those packages at upstream-compatible versions.
2. If many official requirements are absent/inconsistent, install/synchronize from `repo21\requirements.txt` using the existing venv.
3. If installation hits a build/runtime conflict, diagnose the first real blocker and fix that compatibility issue specifically.
4. Do not destroy the existing venv and recreate it unless targeted repair cannot make it coherent.

At minimum, the current observed missing `gradio` must be resolved. The official demo versions are:

```text
gradio==5.33.0
fastapi==0.115.12
uvicorn==0.34.3
```

But do not assume these are the only gaps; verify.

After repair, `pip check` should be clean or any remaining warning must be proven irrelevant to Hunyuan3D runtime and documented as such.

## Phase 3 — import / startup smoke

Before full server launch, run a focused import smoke from `repo21` with the venv. At minimum prove the modules needed by the app import without the previous failure.

Then start the official/local WebUI using the repo's actual supported CLI. Prefer the repo's own current argument definitions over a guessed command.

The expected baseline is equivalent to:

```bat
cd /d D:\Hunyuan3d\repo21
D:\Hunyuan3d\venv\Scripts\python.exe gradio_app.py --model_path tencent/Hunyuan3D-2.1 --subfolder hunyuan3d-dit-v2-1 --low_vram_mode
```

If the current 2.1 UI requires/benefits from the official texture argument, use the repo-supported form, e.g. `--texgen_model_path tencent/Hunyuan3D-2.1`, rather than inventing a flag.

For this 12 GB GPU, keep low-VRAM mode unless a real runtime test proves another configuration is required.

## Phase 4 — real runtime verification

A process merely staying alive is **not** enough.

Acceptance requires all applicable checks below:

1. WebUI server starts without Python traceback.
2. The local URL is reachable from the same machine (normally `http://127.0.0.1:8080` or the actual port printed by the app).
3. The page responds successfully and the Hunyuan3D interface is actually served.
4. Model initialization completes far enough that the UI is usable; no hidden missing-module/model-load error remains in the console.
5. Execute one **minimal real generation smoke** using an existing repo/sample image if one is already available. Do not require the owner to supply a new asset just for this smoke.
6. Confirm the generation returns a model/mesh artifact or reaches the repo's normal successful output state.
7. If texture generation is part of the installed full 2.1 path and can run within the machine's constraints, smoke that path too. If shape generation passes but texture generation is blocked by a distinct optional dependency/VRAM constraint, report it explicitly rather than falsely claiming full PASS.

Do not run repeated expensive generations. One minimal successful end-to-end smoke is enough.

## Model download/cache handling

Before downloading large weights again:

- inspect the existing Hugging Face/local cache and any model directories already present under `D:\Hunyuan3d`;
- reuse complete weights;
- resume an incomplete download instead of duplicating it when possible;
- do not delete cached models as a troubleshooting shortcut.

If the model is genuinely missing, download only what the chosen 2.1 runtime actually needs.

## One-click launcher

Once the runtime is proven, create a simple launcher:

```text
D:\Hunyuan3d\start_hunyuan3d_2_1.bat
```

Requirements:

- changes directory to `D:\Hunyuan3d\repo21`;
- uses `D:\Hunyuan3d\venv\Scripts\python.exe` explicitly;
- launches the exact command that passed the smoke test;
- keeps the console visible on failure so the owner can see the traceback;
- does not depend on global PATH/Python;
- no secrets inside the file.

After creating it, test the `.bat` itself once. Do not claim it works solely because the equivalent manual command worked.

## Acceptance criteria

PASS only when:

- [ ] target is still `D:\Hunyuan3d\repo21` + existing `D:\Hunyuan3d\venv`;
- [ ] missing/broken dependencies have been identified from evidence and repaired;
- [ ] `gradio` import failure is gone;
- [ ] CUDA/Torch still recognize the RTX 4070 Ti;
- [ ] WebUI actually starts and is reachable locally;
- [ ] no startup traceback remains;
- [ ] at least one minimal real shape-generation smoke succeeds;
- [ ] texture path status is explicitly verified/reported if present;
- [ ] `D:\Hunyuan3d\start_hunyuan3d_2_1.bat` is created and itself smoke-tested;
- [ ] existing models/caches/local patches were not unnecessarily destroyed;
- [ ] no unrelated Jarvis/Discord code was modified.

If a hard blocker remains (network/model access/compiler/CUDA incompatibility/etc.), return FAIL with the single root blocker plus exact failed command/error. Do not report partial installation as PASS.

## Scope / do not do

Do not:

- reinstall Windows/NVIDIA drivers without deterministic evidence they are the blocker;
- install into global Python;
- delete/recreate `D:\Hunyuan3d` wholesale;
- delete model caches;
- switch the task to repo20;
- upgrade random packages to latest;
- spend time refactoring upstream code unrelated to runtime;
- modify Jarvis/Discord behavior as part of this task;
- keep testing after all acceptance gates pass.

## Evidence / task closeout

Keep detailed logs local/repository-side; chat output must stay compact.

Final response format:

```text
PASS | FAIL
runtime: <working launch command or none>
launcher: D:\Hunyuan3d\start_hunyuan3d_2_1.bat | none
smoke: <WebUI reachable + generation result, concise>
fix: <main dependency/runtime fix, concise>
blocker: none | <one key blocker>
```

If this task causes no source-code change in the Jarvis repository, do **not** create a fake implementation commit just to have a commit. The taskbook commit is sufficient as the control-plane artifact.

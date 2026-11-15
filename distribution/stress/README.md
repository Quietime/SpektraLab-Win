# SpektraLab stress harnesses

These harnesses separate UI state stress from real native file and render
work. The browser test seeds 2,000 metadata entries in the mock host; those
entries have no corresponding 2,000 raw-image decodes and are explicitly a UI
state/DOM/persistence test. The Python scripts below call the real
`spektralab-host` framed stdio protocol and create real TIFF files.

All native scripts use only the Python standard library. They require a built
host executable and its engine resources directory. For example, in a Linux
build container with the repository mounted at `/work`:

```sh
python3 distribution/stress/native_image_budget.py \
  --host build/host-linux-x64/spektralab-host \
  --resources build/host-linux-x64/engine \
  --receipt build/native-image-budget.receipt.json

python3 distribution/stress/native_file_count.py \
  --host build/host-linux-x64/spektralab-host \
  --resources build/host-linux-x64/engine \
  --receipt build/native-file-count.receipt.json
```

`native_image_budget.py` streams a 192 MiB uncompressed 8192x4096 RGB16 TIFF
to disk, starts a fresh process with
`SPEKTRALAB_VRAM_BUDGET_MB=128`, and requires the controlled memory-budget
error with its exact diagnostic shape. It then opens and fully renders a small
64x48 TIFF in the same process to check recovery. An unrelated Vulkan error,
generic allocation failure, timeout, or small-image failure is a test failure.
The per-request timeout defaults to 180 seconds and can be set with
`--timeout`.

`native_file_count.py` writes 1,000 distinct Unicode-named 32x24 TIFFs and
probes every one through the native host. It then opens, fully renders, and
closes 32 TIFFs with deterministic varying dimensions (up to 1920x1056),
checking the host memory report after every close. The acceptance checks zero
render-pool `live_bytes` and `pending_bytes`, zero pool audit fault counters,
and unchanged SHA-256 hashes for every input. The minimum targets cannot be
lowered through CLI options. The test does not infer a memory plateau from RSS.
Each host request defaults to a 180-second timeout; the whole run defaults to
20 minutes for the file-count script and 10 minutes for the budget script.
Use `--timeout` and `--run-timeout` to adjust those bounds.

Each native script writes a JSON receipt with elapsed time, sampled host RSS,
input hashes and native results. RSS is a sampled resident-set figure for the
host process, not a GPU memory measurement. `physical_gpu_claim` is always
false because the build may use a software Vulkan renderer.

The stress harnesses are intentionally not run as part of routine frontend
typecheck. The 192 MiB TIFF and 32 real full renders require a native Vulkan
host; run them in the controlled build environment after the host has been
built. Do not describe the browser's synthetic metadata test as native import
or the software-renderer receipt as physical-device validation.

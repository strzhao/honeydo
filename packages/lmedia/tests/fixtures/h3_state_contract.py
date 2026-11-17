"""真实 h3 encode/generate 函数的轻量契约测试：假组件替代模型，不加载权重。"""
import importlib.util
import json
import pickle
import sys
import types
from pathlib import Path


class FakeTensor:
    shape = (1, 8, 4096)

    def cpu(self):
        return self


class FakeGenerator:
    def __init__(self, device):
        self.device = device
        self.seed = None

    def manual_seed(self, seed):
        self.seed = seed
        return self


class FakeImage:
    def __init__(self, source):
        self.source = source

    def convert(self, _mode):
        return self

    def resize(self, _size, _filter):
        return self

    def save(self, out, format=None):
        Path(out).write_bytes(b"fake-png")


class FakeState:
    def __init__(self):
        self.values = {}

    def set(self, key, value):
        self.values[key] = value

    def get(self, key):
        return self.values.get(key)


class FakeBlock:
    def __init__(self, fn):
        self.fn = fn

    def __call__(self, _pipe, state):
        self.fn(state)
        return None, state


class FakeAuto:
    def __init__(self, image_fn=None, text_fn=None):
        self.sub_blocks = {}
        if image_fn:
            self.sub_blocks["image_conditioned"] = FakeBlock(image_fn)
        if text_fn:
            self.sub_blocks["text2image"] = FakeBlock(text_fn)


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    encode_path, generate_path, root = map(Path, sys.argv[1:4])
    work = root / "real-state-contract"
    work.mkdir(parents=True, exist_ok=True)

    torch = types.ModuleType("torch")
    torch.Generator = FakeGenerator
    torch.save = lambda payload, path: Path(path).write_bytes(pickle.dumps(payload))
    torch.load = lambda path, weights_only=False: pickle.loads(Path(path).read_bytes())
    sys.modules["torch"] = torch

    image_module = types.ModuleType("PIL.Image")
    image_module.open = FakeImage
    pil = types.ModuleType("PIL")
    pil.Image = image_module
    sys.modules["PIL"] = pil
    sys.modules["PIL.Image"] = image_module

    pipeline_module = types.ModuleType("diffusers.modular_pipelines.modular_pipeline")
    pipeline_module.PipelineState = FakeState
    for name in ("diffusers", "diffusers.modular_pipelines"):
        sys.modules[name] = types.ModuleType(name)
    sys.modules["diffusers.modular_pipelines.modular_pipeline"] = pipeline_module

    encode = load_module("h3_encode_contract", encode_path)
    generate = load_module("h3_generate_contract", generate_path)

    def set_text(state):
        state.set("prompt_embeds", FakeTensor())
        state.set("text_token_tags", FakeTensor())

    def set_latents(state):
        state.set("reference_latents", [FakeTensor()])

    encode_pipe = types.SimpleNamespace(_blocks=types.SimpleNamespace(sub_blocks={
        "before_encode": FakeAuto(lambda _state: None, lambda _state: None),
        "text_encoder": FakeAuto(set_text, set_text),
        "vae_encoder": FakeAuto(set_latents),
    }))
    refs = ["char.png", "style.png"]
    encode.real_encode_one(0, {"prompt": "test", "images": refs, "seed": 17}, work, encode_pipe)
    payload = torch.load(work / "0.pt")
    assert payload["refs"] == refs, "真实 encode 未把 refs 写入共享状态"
    assert payload["seed"] == 17
    assert len(payload["reference_latents"]) == 1

    calls = []

    def selected(branch, decode=False):
        def run(state):
            calls.append(branch)
            if decode:
                state.set("images", [FakeImage("result")])
        return run

    generate_pipe = types.SimpleNamespace(_blocks=types.SimpleNamespace(sub_blocks={
        name: FakeAuto(selected(f"{name}:image_conditioned", name == "decode"),
                       selected(f"{name}:text2image", name == "decode"))
        for name in ("before_encode", "denoise", "decode")
    }))
    out = work / "out.png"
    generate.real_generate_one(
        {"index": 0, "seed": 17, "quality": "draft", "out": str(out)}, work, generate_pipe)
    expected = [f"{name}:image_conditioned" for name in ("before_encode", "denoise", "decode")]
    assert calls == expected, f"参考图分支错误: {calls}"
    assert out.exists()

    payload.pop("reference_latents")
    torch.save(payload, work / "9.pt")
    try:
        generate.real_generate_one(
            {"index": 9, "quality": "draft", "out": str(work / "bad.png")}, work, generate_pipe)
    except RuntimeError as error:
        assert "状态不一致" in str(error)
    else:
        raise AssertionError("refs/reference_latents 不一致时必须 fail-closed")

    print(json.dumps({"ok": True, "calls": calls}, ensure_ascii=False))


if __name__ == "__main__":
    main()

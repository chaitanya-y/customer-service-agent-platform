"""Static packaging contract: never sync dependencies or load a model."""

import tomllib
from pathlib import Path
from urllib.parse import unquote

import pytest
from packaging.markers import Marker

PROJECT = Path(__file__).resolve().parents[1]
CPU_INDEX = "https://download.pytorch.org/whl/cpu"


def _read(name: str) -> dict:
    with (PROJECT / name).open("rb") as source:
        return tomllib.load(source)


@pytest.mark.parametrize("architecture", ["aarch64", "x86_64"])
def test_linux_torch_uses_cpu_wheels_without_gpu_dependencies(
    architecture: str,
) -> None:
    """A PyPI/GPU Torch fallback or missing target wheel breaks this contract."""
    lock = _read("uv.lock")
    packages = lock["package"]
    root = next(package for package in packages if package["name"] == "knowledge-rag")
    environment = {"sys_platform": "linux", "platform_machine": architecture}
    torch_edges = [
        edge
        for edge in root["dependencies"]
        if edge["name"] == "torch"
        and Marker(edge.get("marker", "python_version >= '3.12'")).evaluate(environment)
    ]
    assert len(torch_edges) == 1, (
        "Linux must explicitly select exactly one Torch variant"
    )
    edge = torch_edges[0]
    assert edge.get("version") == "2.13.0+cpu"
    torch = next(
        package
        for package in packages
        if package["name"] == "torch" and package["version"] == edge["version"]
    )
    assert torch["source"] == {"registry": CPU_INDEX}
    wheel_names = [unquote(wheel["url"]) for wheel in torch["wheels"]]
    assert any(
        f"cp312-cp312-manylinux_2_28_{architecture}.whl" in url for url in wheel_names
    )
    assert all(
        not dependency["name"].startswith(("cuda-", "nvidia-", "triton"))
        for dependency in torch["dependencies"]
    )


@pytest.mark.parametrize("platform", ["darwin", "win32"])
def test_non_linux_torch_retains_pypi_version(platform: str) -> None:
    lock = _read("uv.lock")
    packages = lock["package"]
    root = next(package for package in packages if package["name"] == "knowledge-rag")
    torch_edges = [
        edge
        for edge in root["dependencies"]
        if edge["name"] == "torch"
        and Marker(edge.get("marker", "python_version >= '3.12'")).evaluate(
            {"sys_platform": platform}
        )
    ]
    assert len(torch_edges) == 1
    assert torch_edges[0]["version"] == "2.13.0"
    torch = next(
        package
        for package in packages
        if package["name"] == "torch" and package["version"] == "2.13.0"
    )
    assert torch["source"] == {"registry": "https://pypi.org/simple"}


def test_cpu_index_is_explicit_and_existing_ml_versions_remain_pinned() -> None:
    project = _read("pyproject.toml")
    assert "torch==2.13.0" in project["project"]["dependencies"]
    index = next(
        index
        for index in project["tool"]["uv"].get("index", [])
        if index["url"] == CPU_INDEX
    )
    assert index["explicit"] is True
    source = project["tool"]["uv"]["sources"]["torch"]
    assert source["index"] == index["name"]
    assert Marker(source["marker"]).evaluate({"sys_platform": "linux"})
    assert not Marker(source["marker"]).evaluate({"sys_platform": "darwin"})
    versions = {
        package["name"]: package["version"] for package in _read("uv.lock")["package"]
    }
    assert versions["sentence-transformers"] == "5.7.0"
    assert versions["transformers"] == "5.15.0"

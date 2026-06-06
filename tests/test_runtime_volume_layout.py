from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "server"))
sys.path.insert(0, str(ROOT / "plugins"))

from wt_volume.components.volume import VolumeRendererComponent
from witwin_server.features.assets.binary.handlers import BinaryAssetHandler
from witwin_server.persistence import PROJECT_DIR_ENV, PersistenceManager


class _StubServer:
    def __init__(self, scene_dir: Path) -> None:
        self.default_scene_dir = scene_dir
        self.verbose = False


def test_runtime_volume_dir_lives_under_witwin(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(PROJECT_DIR_ENV, str(tmp_path))
    pm = PersistenceManager(_StubServer(tmp_path))

    assert pm.runtime_volumes_dir == tmp_path / ".witwin" / "runtime" / "volumes"
    assert not (tmp_path / "volumes").exists()


def test_volume_candidate_paths_prefer_runtime_then_user_then_legacy(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(PROJECT_DIR_ENV, str(tmp_path))
    pm = PersistenceManager(_StubServer(tmp_path))

    assert pm.volume_candidate_dirs() == [
        tmp_path / ".witwin" / "runtime" / "volumes",
        tmp_path / "assets" / "volumes",
        tmp_path / "volumes",
    ]


def test_volume_disk_export_fallback_uses_hidden_runtime_dir(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(PROJECT_DIR_ENV, str(tmp_path))
    pm = PersistenceManager(_StubServer(tmp_path))

    class _Server:
        persistence = pm
        verbose = False
        handlers = {}

    server = _Server()
    server.handlers["binary_assets"] = BinaryAssetHandler(server)

    class _Scene:
        _server = server

        def _emit(self, *args, **kwargs) -> None:
            pass

    class _Owner:
        id = "volume-owner"
        scene = _Scene()

    component = VolumeRendererComponent()
    component._owner = _Owner()
    component.cache_in_memory = False
    component._volume_data = np.ones((2, 2, 2), dtype=np.float32)

    result = component.export_volume_data()

    assert result.startswith("Exported volume:")
    assert not (tmp_path / "volumes").exists()
    assert list((tmp_path / ".witwin" / "runtime" / "volumes").glob("*"))

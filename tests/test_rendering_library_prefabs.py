from __future__ import annotations

import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "server"))
sys.path.insert(0, str(ROOT / "plugins"))

from wt_volume import components as _volume_components  # noqa: F401
from witwin_server.core import Scene
from witwin_server.features.assets.binary.handlers import BinaryAssetHandler
from witwin_server.features.library.service import LibraryHandler
from witwin_server.persistence import PersistenceManager


class _PersistenceServer:
    def __init__(self, project_dir: Path) -> None:
        self.default_scene_dir = project_dir
        self.verbose = False


class _Server:
    verbose = False
    main_scene_id = "default"

    def __init__(self, project_dir: Path) -> None:
        self.scene = Scene(scene_id=self.main_scene_id, role="main")
        self.scene._server = self
        self.persistence = PersistenceManager(_PersistenceServer(project_dir))
        self.handlers = {}

    def get_scene(self, scene_id: str | None = None):
        return self.scene

    async def broadcast(self, *args, **kwargs) -> None:
        pass

    def _safe_broadcast(self, *args, **kwargs) -> None:
        pass


def test_rendering_library_prefabs_export_resource_refs_after_scene_attach(tmp_path: Path) -> None:
    server = _Server(tmp_path)
    server.handlers["binary_assets"] = BinaryAssetHandler(server)
    library = LibraryHandler(server)

    for item_id, component_name, ref_field in [
        ("volume", "VolumeRenderer", "volume"),
        ("sdf", "SDFRenderer", "volume"),
        ("pointclouds", "PointClouds", "cloud"),
    ]:
        result = asyncio.run(
            library._handle_create_from_library(
                {"item_id": item_id, "position": [0, 0, 0]},
                websocket=None,
            )
        )

        obj = server.scene.get_object(result["object_id"])
        component = obj.get_component(component_name)
        values = component.to_dict()["values"]

        assert values[ref_field]
        assert values[ref_field]["uri"].startswith("/scenes/default/assets/")

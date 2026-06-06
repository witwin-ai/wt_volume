from __future__ import annotations

import asyncio
import importlib
import sys
from pathlib import Path

import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "server"))
sys.path.insert(0, str(ROOT / "plugins"))

from wt_volume.components.sdf import SDFRendererComponent
from wt_volume.components.volume import VolumeRendererComponent
from witwin_server.core import Scene, SceneObject
from witwin_server.features.components.handlers import ComponentsHandler
from witwin_server.features.assets.binary.handlers import BinaryAssetHandler
from witwin_server.features.assets.binary.refs import (
    POINT_CLOUD_FORMAT,
    VOLUME_FLOAT32_FORMAT,
    RenderResourceRef,
)
from witwin_server.features.assets.binary.service import BinaryAssetService
from witwin_server.persistence import PersistenceManager


class _PersistenceServer:
    def __init__(self, project_dir: Path) -> None:
        self.default_scene_dir = project_dir
        self.verbose = False


class _Scene:
    def __init__(self, server: object) -> None:
        self._server = server
        self.events: list[tuple[str, dict]] = []

    def _emit(self, *args, **kwargs) -> None:
        self.events.append((args[0], kwargs))


class _Owner:
    id = "resource-owner"

    def __init__(self, server: object) -> None:
        self.scene = _Scene(server)


def _make_handler(tmp_path: Path) -> BinaryAssetHandler:
    class _Server:
        verbose = False

        def __init__(self) -> None:
            self.persistence = PersistenceManager(_PersistenceServer(tmp_path))

    return BinaryAssetHandler(_Server())


def test_render_resource_ref_serializes_camel_case_payload() -> None:
    ref = RenderResourceRef(
        asset_id="volume-1",
        uri="/scenes/default/assets/volume-1",
        kind="volume",
        format=VOLUME_FLOAT32_FORMAT,
        byte_length=16,
        content_hash="sha256:abc",
        shape=[2, 2, 1],
        attributes={"dtype": "float32"},
    )

    assert ref.to_dict() == {
        "assetId": "volume-1",
        "uri": "/scenes/default/assets/volume-1",
        "kind": "volume",
        "format": VOLUME_FLOAT32_FORMAT,
        "byteLength": 16,
        "contentHash": "sha256:abc",
        "version": 1,
        "sceneId": "default",
        "shape": [2, 2, 1],
        "attributes": {"dtype": "float32"},
    }


def test_binary_asset_service_registers_bytes_and_returns_ref() -> None:
    service = BinaryAssetService()

    ref = service.register_bytes(
        kind="point_cloud",
        format=POINT_CLOUD_FORMAT,
        data=b"PCLD-data",
        shape=[1],
        attributes={"point_count": 1},
    )

    assert ref.asset_id.startswith("point_cloud-")
    assert ref.uri == f"/scenes/default/assets/{ref.asset_id}"
    assert ref.byte_length == len(b"PCLD-data")
    assert service.get_bytes(ref.asset_id) == b"PCLD-data"


def test_renderer_components_are_plugin_owned_while_field_stays_core() -> None:
    assert importlib.import_module("witwin_server.core.components.field_region").FieldComponent
    assert importlib.import_module("wt_volume.components.volume").VolumeRendererComponent
    assert importlib.import_module("wt_volume.components.sdf").SDFRendererComponent

    with pytest.raises(ModuleNotFoundError):
        importlib.import_module("witwin_server.core.components.volume_renderer")
    with pytest.raises(ModuleNotFoundError):
        importlib.import_module("witwin_server.core.components.sdf_renderer")
    with pytest.raises(ModuleNotFoundError):
        importlib.import_module("witwin_server.core.components.point_clouds")
    with pytest.raises(ModuleNotFoundError):
        importlib.import_module("wt_volume.components.point_cloud")


def test_binary_asset_handler_keeps_only_generic_asset_route() -> None:
    assert BinaryAssetHandler.message_types == []
    assert BinaryAssetHandler.dispatch_map == {}


def test_canonical_asset_route_serves_registered_bytes_and_old_routes_are_gone(tmp_path: Path) -> None:
    handler = _make_handler(tmp_path)
    handler.cache_data("volume-abc", b"volume-bytes")
    app = FastAPI()
    handler.setup_routes(app)
    client = TestClient(app)

    response = client.get("/scenes/default/assets/volume-abc")
    assert response.status_code == 200
    assert response.content == b"volume-bytes"

    assert client.get("/scenes/default/assets/volumes/volume-abc").status_code == 404
    assert client.get("/scenes/default/volumes/volume-abc.raw").status_code == 404
    assert client.get("/scenes/default/pointclouds/volume-abc.bin").status_code == 404


def test_volume_export_publishes_resource_ref_not_volume_id(tmp_path: Path) -> None:
    handler = _make_handler(tmp_path)

    class _Server:
        verbose = False
        persistence = handler.server.persistence
        handlers = {"binary_assets": handler}

    owner = _Owner(_Server())
    component = VolumeRendererComponent()
    component._owner = owner
    component.cache_in_memory = True
    component._volume_data = np.ones((2, 2, 2), dtype=np.float32)

    result = component.export_volume_data()
    values = component.to_dict()["values"]

    assert result.startswith("Cached volume:")
    assert "volume" in values
    assert values["volume"]["kind"] == "volume"
    assert values["volume"]["format"] == VOLUME_FLOAT32_FORMAT
    assert "volume_id" not in values
    assert (
        "component_updated",
        {
            "object_id": "resource-owner",
            "component_name": "VolumeRenderer",
            "field_name": "volume",
            "value": values["volume"],
        },
    ) in owner.scene.events


def test_generate_buttons_publish_render_resource_refs_through_component_handler(tmp_path: Path) -> None:
    class _Server:
        verbose = False
        main_scene_id = "default"

        def __init__(self) -> None:
            self.scene = Scene(scene_id=self.main_scene_id, role="main")
            self.scene._server = self
            self.persistence = PersistenceManager(_PersistenceServer(tmp_path))
            self.handlers = {"binary_assets": BinaryAssetHandler(self)}

        def get_scene(self, scene_id: str | None = None):
            return self.scene

    server = _Server()
    events: list[tuple[str, dict]] = []
    server.scene._emit = lambda event, **kwargs: events.append((event, kwargs))
    handler = ComponentsHandler(server)

    cases = [
        (VolumeRendererComponent(), "VolumeRenderer", "generate_test_volume", "volume", "volume"),
        (SDFRendererComponent(), "SDFRenderer", "generate_sdf_sphere", "volume", "volume"),
    ]

    for component, component_name, button_name, ref_field, kind in cases:
        obj = SceneObject(name=f"{component_name} Object", mesh_type="Empty")
        obj.add_component(component)
        server.scene.add_object(obj)

        result = asyncio.run(
            handler._handle_click_button(
                {
                    "object_id": obj.id,
                    "component_name": component_name,
                    "button_name": button_name,
                },
                websocket=None,
            )
        )
        values = obj.get_component(component_name).to_dict()["values"]
        ref = values[ref_field]

        assert result["type"] == "button_click_result"
        assert result["success"] is True
        assert ref["kind"] == kind
        assert ref["uri"].startswith("/scenes/default/assets/")
        assert (
            "component_updated",
            {
                "object_id": obj.id,
                "component_name": component_name,
                "field_name": ref_field,
                "value": ref,
            },
        ) in events

from __future__ import annotations

import importlib
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "server"))
sys.path.insert(0, str(ROOT / "plugins"))

from wt_volume.components.sdf import SDFRendererComponent
from wt_volume.components.volume import VolumeRendererComponent
from witwin_server.api import Scene, SceneObject
from witwin_server.api import (
    POINT_CLOUD_FORMAT,
    VOLUME_FLOAT32_FORMAT,
    RenderResourceRef,
    BinaryAssetService,
)


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


def _asset_server(tmp_path: Path) -> SimpleNamespace:
    """A server with only what the components reach: handlers["binary_assets"].service.

    The persistence stand-in gives the service a runtime volume folder; the
    real folder layout is Studio's and is tested there.
    """
    volumes = tmp_path / ".witwin" / "runtime" / "volumes"
    persistence = SimpleNamespace(runtime_volumes_dir=volumes, volume_candidate_dirs=lambda: [volumes])
    service = BinaryAssetService(persistence=persistence)
    return SimpleNamespace(verbose=False, handlers={"binary_assets": SimpleNamespace(service=service)})


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


def test_renderer_components_are_plugin_owned_while_field_is_studio_em() -> None:
    em_api = importlib.import_module("witwin_server.plugins_builtin.em.api")
    assert em_api.FieldComponent
    api = importlib.import_module("wt_volume.api")
    assert api.VolumeRendererComponent is VolumeRendererComponent
    assert api.SDFRendererComponent is SDFRendererComponent

    with pytest.raises(ModuleNotFoundError):
        importlib.import_module("wt_volume.components.point_cloud")


def test_volume_export_publishes_resource_ref_not_volume_id(tmp_path: Path) -> None:
    owner = _Owner(_asset_server(tmp_path))
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


def test_volume_resource_ref_round_trips_through_scene_properties() -> None:
    ref = RenderResourceRef(
        asset_id="volume-1",
        uri="/scenes/default/assets/volume-1",
        kind="volume",
        format=VOLUME_FLOAT32_FORMAT,
        byte_length=32,
        content_hash="sha256:abc",
        shape=[2, 2, 2],
        attributes={"dtype": "float32"},
    ).to_dict()
    component = VolumeRendererComponent()
    component._publish_volume_ref(ref)
    props = component.to_properties_dict()["properties"]

    loaded = VolumeRendererComponent()
    loaded.from_properties_dict(props)

    assert loaded.to_dict()["values"]["volume"] == ref


def test_generate_buttons_publish_render_resource_refs(tmp_path: Path) -> None:
    server = _asset_server(tmp_path)
    scene = Scene(scene_id="default", role="main")
    scene._server = server
    events: list[tuple[str, dict]] = []
    scene._emit = lambda event, **kwargs: events.append((event, kwargs))

    cases = [
        (VolumeRendererComponent(), "VolumeRenderer", "generate_test_volume", "volume", "volume"),
        (SDFRendererComponent(), "SDFRenderer", "generate_sdf_sphere", "volume", "volume"),
    ]

    for component, component_name, button_name, ref_field, kind in cases:
        obj = SceneObject(name=f"{component_name} Object", mesh_type="Empty")
        obj.add_component(component)
        scene.add_object(obj)

        # The Inspector button runs the decorated method on the component.
        result = getattr(obj.get_component(component_name), button_name)()
        values = obj.get_component(component_name).to_dict()["values"]
        ref = values[ref_field]

        assert result.startswith("Generated")
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

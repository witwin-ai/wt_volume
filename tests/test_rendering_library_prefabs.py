from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "server"))
sys.path.insert(0, str(ROOT / "plugins"))

import wt_volume  # noqa: F401
from wt_volume import library_items
from witwin_server.api import BinaryAssetService, Scene
from witwin_server.api import testing


def _scene(tmp_path: Path) -> Scene:
    volumes = tmp_path / ".witwin" / "runtime" / "volumes"
    persistence = SimpleNamespace(runtime_volumes_dir=volumes, volume_candidate_dirs=lambda: [volumes])
    service = BinaryAssetService(persistence=persistence)
    scene = Scene(scene_id="default", role="main")
    scene._server = SimpleNamespace(verbose=False, handlers={"binary_assets": SimpleNamespace(service=service)})
    return scene


def test_rendering_library_prefabs_export_resource_refs_after_scene_attach(tmp_path: Path) -> None:
    scene = _scene(tmp_path)

    for factory, component_name, ref_field in [
        (library_items._make_field_demo, "Field", "volume"),
        (library_items._make_volume_demo, "VolumeRenderer", "volume"),
        (library_items._make_sdf_demo, "SDFRenderer", "volume"),
    ]:
        obj = factory(SimpleNamespace(name=component_name, position=[0, 0, 0], parent_id=None, scene=scene))
        # Library adds the factory's object to the scene, then calls start()
        # on its components; start exports the pending grid.
        scene.add_object(obj)
        component = obj.get_component(component_name)
        component.start()
        values = component.to_dict()["values"]

        assert values[ref_field]
        assert values[ref_field]["uri"].startswith("/scenes/default/assets/")


def test_volume_plugin_contributes_volume_category_without_pointcloud(monkeypatch) -> None:
    assert {"field", "volume", "sdf"} <= testing.library_item_ids()
    assert "pointclouds" not in testing.library_item_ids()

    categories: dict = {}
    items: dict = {}
    recorder = SimpleNamespace(
        register_category=lambda category_id, name, **kwargs: categories.__setitem__(category_id, name),
        register_item=lambda item_id, name, category, **kwargs: items.__setitem__(item_id, category),
    )
    monkeypatch.setattr(library_items, "Library", recorder)
    library_items.register()

    assert categories["volume"] == "Volume"
    assert items == {"field": "volume", "volume": "volume", "sdf": "volume"}

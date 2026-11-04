from __future__ import annotations

import numpy as np

import inspect as _inspect
from pathlib import Path as _Path

from witwin_server import Library, SceneObject


_PREVIEWS = _Path(__file__).resolve().parent / "previews" / "library"


def _preview(item_id):
    """The Library card image for an item, as keyword arguments.

    Images are renders from Studio's `scripts/template-previews/library_items.py`.
    Empty when the file is missing or Studio's `register_item` has no `preview`
    parameter yet (older Studio), so the card falls back to the item's icon.
    """
    path = _PREVIEWS / f"{item_id}.webp"
    if not path.is_file() or "preview" not in _inspect.signature(Library.register_item).parameters:
        return {}
    return {"preview": str(path)}

from .components.sdf import SDFRendererComponent
from .components.volume import VolumeRendererComponent


_CATEGORY = "volume"


def _sphere_volume(resolution: int = 64) -> np.ndarray:
    x = np.linspace(-1, 1, resolution)
    y = np.linspace(-1, 1, resolution)
    z = np.linspace(-1, 1, resolution)
    grid_x, grid_y, grid_z = np.meshgrid(x, y, z, indexing="ij")
    distance = np.sqrt(grid_x**2 + grid_y**2 + grid_z**2)

    radius = 0.7
    edge_width = 0.2
    volume = np.zeros_like(distance)
    mask_inner = distance <= (radius - edge_width)
    mask_edge = (distance > (radius - edge_width)) & (distance <= (radius + edge_width))

    volume[mask_inner] = 1.0
    t = (distance[mask_edge] - (radius - edge_width)) / (2 * edge_width)
    volume[mask_edge] = 1.0 - (3 * t**2 - 2 * t**3)
    return np.clip(volume, 0, 1).astype(np.float32)


def _sphere_sdf(resolution: int = 64) -> np.ndarray:
    x = np.linspace(-1, 1, resolution)
    y = np.linspace(-1, 1, resolution)
    z = np.linspace(-1, 1, resolution)
    grid_x, grid_y, grid_z = np.meshgrid(x, y, z, indexing="ij")
    return np.clip(np.sqrt(grid_x**2 + grid_y**2 + grid_z**2) - 0.6, -1.0, 1.0).astype(np.float32)


def _make_field_demo(ctx) -> SceneObject:
    obj = SceneObject(name=ctx.name, mesh_type="Empty")
    field = obj.add_component("Field")
    obj["Transform"].freeze_scale = True
    field.set_volume_data(_sphere_volume())
    field.set_field("render_mode", "Volume", force=True)
    field.set_field("colormap", "viridis", force=True)
    field.set_field("display_range", [0.1, 1.0], force=True)
    return obj


def _make_volume_demo(ctx) -> SceneObject:
    obj = SceneObject(name=ctx.name, mesh_type="Empty")
    component = VolumeRendererComponent()
    obj.add_component(component)
    component.set_volume_data(_sphere_volume())
    component.set_field("colormap", "viridis", force=True)
    component.set_field("opacity_scale", 1.2, force=True)
    component.set_field("density_scale", 1.0, force=True)
    component.set_field("value_min", 0.1, force=True)
    component.set_field("value_max", 1.0, force=True)
    component.set_field("ray_steps", 128, force=True)
    return obj


def _make_sdf_demo(ctx) -> SceneObject:
    obj = SceneObject(name=ctx.name, mesh_type="Empty")
    component = SDFRendererComponent()
    obj.add_component(component)
    component.set_volume_data(_sphere_sdf())
    component.set_field("iso_value", 0.0, force=True)
    component.set_field("enable_lighting", True, force=True)
    component.set_field("colormap", "viridis", force=True)
    return obj


def register() -> None:
    Library.register_category(_CATEGORY, "Volume", icon="box-select", order=20)
    Library.register_item(
        "field",
        "Field",
        _CATEGORY,
        object_type="field",
        icon="grid-3x3",
        factory=_make_field_demo,
        description="Field region with a plugin-owned volume preview", **_preview("field"),
    )
    Library.register_item(
        "volume",
        "Volume",
        _CATEGORY,
        object_type="volume",
        icon="box-select",
        factory=_make_volume_demo,
        description="Volume renderer with a generated scalar field", **_preview("volume"),
    )
    Library.register_item(
        "sdf",
        "SDF Renderer",
        _CATEGORY,
        object_type="sdf",
        icon="sphere",
        factory=_make_sdf_demo,
        description="Signed distance field renderer with a generated sphere", **_preview("sdf"),
    )


register()

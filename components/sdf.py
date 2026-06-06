"""
SDF Renderer component for signed distance field visualization using sphere tracing.

Supports visualization of SDF data with:
- GPU-accelerated sphere tracing
- Surface lighting (Phong model)
- Isosurface extraction
"""
import numpy as np
import torch

from witwin_server.core.components.core import (
    bool_field,
    button,
    component,
    float_field,
    int_field,
    string_field,
    vector3_field,
)
from witwin_server.core.components.volume_base import VolumeRendererBase


@component(name="SDFRenderer", category="Rendering/Volume")
class SDFRendererComponent(VolumeRendererBase):
    """SDF renderer component for signed distance field visualization using sphere tracing."""

    # ===== Volume Data Properties =====
    resolution = vector3_field(
        [128, 128, 128],
        description="Volume grid resolution (X, Y, Z)",
        group="Volume Data"
    )

    # ===== SDF-Specific Fields =====
    render_technique = string_field(
        "sdf",
        options=["sdf", "isosurface"],
        description="Rendering technique: sdf (sphere tracing), isosurface (marching cubes style)",
        group="SDF Rendering",
        enum_toggle=True
    )

    iso_value = float_field(
        0.0, min=-1.0, max=1.0, step=0.01,
        description="Isosurface threshold value (0.0 = surface for SDFs)",
        group="SDF Rendering"
    )

    enable_lighting = bool_field(
        True,
        description="Enable surface lighting (Phong shading)",
        group="SDF Rendering"
    )

    # ===== Transfer Function (Colormap) =====
    colormap = string_field(
        "viridis",
        options=["inferno", "viridis", "jet", "plasma", "coolwarm", "bwr"],
        description="Color mapping for surface",
        group="Appearance",
        enum_toggle=True
    )

    opacity_scale = float_field(
        1.0, min=0.0, max=5.0, step=0.01,
        description="Global opacity multiplier",
        group="Appearance"
    )

    density_scale = float_field(
        1.0, min=0.0, max=5.0, step=0.01,
        description="Density multiplier",
        group="Appearance"
    )

    # ===== Value Range Threshold =====
    value_min = float_field(
        0.0, min=0.0, max=1.0, step=0.01,
        description="Minimum visible value (normalized 0-1)",
        group="Threshold"
    )

    value_max = float_field(
        1.0, min=0.0, max=1.0, step=0.01,
        description="Maximum visible value (normalized 0-1)",
        group="Threshold"
    )

    # ===== Ray Marching Quality =====
    ray_steps = int_field(
        128, min=32, max=512, step=16,
        description="Number of sphere tracing steps (higher = better quality, slower)",
        group="Quality"
    )

    # ===== Slice Viewing =====
    show_slice = bool_field(
        False,
        description="Show 2D slice instead of full volume",
        group="Slice View"
    )

    slice_plane = string_field(
        "XZ",
        options=["XY", "XZ", "YZ"],
        description="Slice plane orientation",
        group="Slice View",
        enum_toggle=True
    )

    slice_position = float_field(
        0.5, min=0.0, max=1.0, step=0.01,
        description="Slice position along perpendicular axis (0=min, 1=max)",
        group="Slice View"
    )

    # ===== Internal State =====
    cache_in_memory = bool_field(
        True,
        description="Cache volume data in memory (fast, no disk I/O). Disable to save to disk files.",
        group="Volume Data"
    )

    # ===== Button Methods =====

    @button(display_name="Generate SDF (Sphere)", description="Generate a signed distance field for sphere tracing")
    def generate_sdf_sphere(self):
        """Generate SDF (Signed Distance Field) data for demonstration."""
        res = self.resolution.tolist() if hasattr(self.resolution, 'tolist') else list(self.resolution)
        nx, ny, nz = int(res[0]), int(res[1]), int(res[2])

        # Create coordinate grids normalized to [-1, 1]
        x = np.linspace(-1, 1, nx)
        y = np.linspace(-1, 1, ny)
        z = np.linspace(-1, 1, nz)
        X, Y, Z = np.meshgrid(x, y, z, indexing='ij')

        # SDF: distance to sphere surface (negative inside, positive outside)
        sphere_radius = 0.6
        sdf = np.sqrt(X**2 + Y**2 + Z**2) - sphere_radius

        # Normalize to roughly [-1, 1] for better visualization
        # Clamp extreme values
        sdf = np.clip(sdf, -1.0, 1.0)

        # Store as PyTorch tensor (no normalization needed for SDF!)
        self._volume_data = torch.from_numpy(sdf.astype(np.float32))

        # Set SDF-specific defaults
        self.set_field('iso_value', 0.0, force=True)  # Surface at distance=0
        self.set_field('enable_lighting', True, force=True)
        self.set_field('colormap', 'viridis', force=True)

        # Auto-export the volume data
        export_result = self.export_volume_data()

        return f"Generated SDF sphere: {nx}x{ny}x{nz}, {export_result}"

    @button(display_name="Load from NumPy", description="Load SDF from .npy file")
    def load_from_numpy_file(self):
        """Load SDF from .npy file path.

        Note: This button just shows the API. In practice, use set_volume_data() from code.
        """
        return "Use set_volume_data(data) API from code to load SDF data"

"""
Volume Renderer component for 3D scalar field visualization using ray marching.

Supports visualization of large 3D volume data (512鲁+) with:
- GPU-accelerated ray marching rendering
- Multiple colormap options
- Interactive transfer function controls (opacity, density, value range)
- 2D slice viewing
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
from witwin_server.core.components.scalar_grid_resource import ScalarGridResourcePublisher


@component(name="VolumeRenderer", category="Rendering/Volume")
class VolumeRendererComponent(ScalarGridResourcePublisher):
    """Volume renderer component for 3D scalar field visualization using ray marching."""

    # ===== Volume Data Properties =====
    resolution = vector3_field(
        [128, 128, 128],
        description="Volume grid resolution (X, Y, Z)",
        group="Volume Data"
    )

    # ===== Transfer Function (Colormap + Opacity) =====
    colormap = string_field(
        "viridis",
        options=["inferno", "viridis", "jet", "plasma", "coolwarm", "bwr"],
        description="Color mapping for values",
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
        description="Density multiplier (affects accumulation)",
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
        description="Number of ray marching steps (higher = better quality, slower)",
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

    @button(display_name="Generate Test Volume", description="Generate a test 3D volume (sphere + noise)")
    def generate_test_volume(self):
        """Generate test 3D volume data for demonstration.

        Uses smoothstep falloff (matching Library default) for clear visualization.
        """
        res = self.resolution.tolist() if hasattr(self.resolution, 'tolist') else list(self.resolution)
        nx, ny, nz = int(res[0]), int(res[1]), int(res[2])

        # Create coordinate grids normalized to [-1, 1]
        x = np.linspace(-1, 1, nx)
        y = np.linspace(-1, 1, ny)
        z = np.linspace(-1, 1, nz)
        X, Y, Z = np.meshgrid(x, y, z, indexing='ij')

        # Calculate distance from center
        distance = np.sqrt(X**2 + Y**2 + Z**2)

        # Create smooth spherical falloff (1 at center, 0 at edges)
        # Using smooth step function for better visualization (matches Library default)
        radius = 0.7  # Sphere radius
        edge_width = 0.2  # Smoothness of the edge

        volume = np.zeros_like(distance)

        # Smooth falloff
        mask_inner = distance <= (radius - edge_width)
        mask_edge = (distance > (radius - edge_width)) & (distance <= (radius + edge_width))
        mask_outer = distance > (radius + edge_width)

        volume[mask_inner] = 1.0
        # Smooth transition at edge using smoothstep
        t = (distance[mask_edge] - (radius - edge_width)) / (2 * edge_width)
        volume[mask_edge] = 1.0 - (3*t**2 - 2*t**3)  # smoothstep
        volume[mask_outer] = 0.0

        # Add slight noise for visual interest (5% not 20%)
        noise = np.random.rand(nx, ny, nz) * 0.05
        volume = np.clip(volume + noise, 0, 1)

        # Store as PyTorch tensor (already normalized to 0-1)
        self._volume_data = torch.from_numpy(volume.astype(np.float32))

        # Set visualization parameters (matching Library defaults)
        self.set_field('colormap', 'viridis', force=True)
        self.set_field('opacity_scale', 1.2, force=True)
        self.set_field('density_scale', 1.0, force=True)
        self.set_field('value_min', 0.1, force=True)  # Hide very low values
        self.set_field('value_max', 1.0, force=True)
        self.set_field('ray_steps', 128, force=True)

        # Auto-export the volume data
        export_result = self.export_volume_data()

        return f"Generated test volume: {nx}x{ny}x{nz}, {export_result}"

    @button(display_name="Load from NumPy", description="Load volume from .npy file")
    def load_from_numpy_file(self):
        """Load volume from .npy file path.

        Note: This button just shows the API. In practice, use set_volume_data() from code.
        """
        return "Use set_volume_data(data) API from code to load volume data"

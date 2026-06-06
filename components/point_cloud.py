"""
Point Clouds component for visualizing large datasets of 3D points with heat values.

Supports:
- 10,000+ points with efficient binary serialization
- Per-point heat values with colormap visualization
- Flexible key-value metadata per point
- Instanced rendering for high performance
"""
from typing import Dict, Any, Optional, Union, List
import torch
import numpy as np
import struct
import json

from witwin_server.core.components.core import (
    Component, component, button,
    string_field, float_field, int_field, bool_field
)
from witwin_server.features.assets.binary.refs import POINT_CLOUD_FORMAT


@component(name="PointClouds", category="Visual/Geometry")
class PointCloudsComponent(Component):
    """Point cloud visualization component with heat mapping and metadata support.

    Efficiently handles 10,000+ points with per-point heat values and extra_data.
    Uses instanced rendering for high performance.
    """

    # ===== Point Cloud Metadata =====
    point_count = int_field(
        0,
        readonly=True,
        description="Number of points in the cloud",
        group="Point Cloud Data"
    )

    # ===== Appearance Settings =====
    point_size = float_field(
        0.05,
        min=0.001,
        max=1.0,
        step=0.001,
        description="Sphere radius for each point",
        group="Appearance"
    )

    colormap = string_field(
        "viridis",
        options=["viridis", "plasma", "inferno", "jet", "coolwarm", "bwr"],
        description="Color mapping for heat values",
        group="Appearance",
        enum_toggle=True
    )

    # ===== Heat Value Range =====
    heat_min = float_field(
        0.0,
        description="Minimum heat value for color mapping (auto-computed from data)",
        group="Heat Mapping",
        readonly=True
    )

    heat_max = float_field(
        1.0,
        description="Maximum heat value for color mapping (auto-computed from data)",
        group="Heat Mapping",
        readonly=True
    )

    normalize_heat = bool_field(
        True,
        description="Auto-normalize heat values to [0, 1] range",
        group="Heat Mapping"
    )

    # ===== Display Options =====
    show_points = bool_field(
        True,
        description="Toggle point cloud visibility",
        group="Display"
    )

    opacity = float_field(
        1.0,
        min=0.0,
        max=1.0,
        step=0.01,
        description="Overall point cloud opacity",
        group="Display"
    )

    point_scale = float_field(
        1.0,
        min=0.1,
        max=10.0,
        step=0.1,
        description="Scale factor for point size",
        group="Display"
    )

    space_mode = string_field(
        "screen",
        options=["world", "screen"],
        description="World Space: size in world units. Screen Space: constant screen size",
        group="Display",
        enum_toggle=True
    )

    def __init__(self, **kwargs):
        """Initialize point clouds component."""
        # Internal storage - NOT synced to frontend
        self._positions: Optional[torch.Tensor] = None  # Shape: (N, 3) - xyz coordinates
        self._heat: Optional[torch.Tensor] = None       # Shape: (N,) - heat scalars
        self._extra_data: Optional[List[Dict]] = None   # Length: N - arbitrary key-value data

        super().__init__(**kwargs)

    def _publish_cloud_ref(self, value: Any) -> None:
        self._values['cloud'] = value
        if not hasattr(self, '_owner') or not self._owner:
            return
        scene = getattr(self._owner, 'scene', None)
        if scene:
            scene._emit(
                'component_updated',
                object_id=self._owner.id,
                component_name=self._component_name,
                field_name='cloud',
                value=value,
            )

    def set_points(
        self,
        positions: Union[np.ndarray, torch.Tensor, List],
        heat: Optional[Union[np.ndarray, torch.Tensor, List]] = None,
        extra_data: Optional[List[Dict]] = None
    ):
        """Set point cloud data from arrays.

        This is the PRIMARY API for external code to provide point cloud data.

        Args:
            positions: Nx3 array of [x, y, z] coordinates
            heat: N array of scalar heat values (optional, defaults to 0.5)
            extra_data: List of N dictionaries with arbitrary metadata (optional)

        Example:
            pc = obj.add_component("PointClouds")
            positions = np.random.randn(1000, 3)
            heat = np.random.rand(1000)
            extra_data = [{"label": f"Point_{i}", "temp": np.random.rand()} for i in range(1000)]
            pc.set_points(positions, heat, extra_data)
        """
        # Convert positions to tensor
        if isinstance(positions, np.ndarray):
            positions = torch.from_numpy(positions.astype(np.float32))
        elif isinstance(positions, list):
            positions = torch.tensor(positions, dtype=torch.float32)
        elif not isinstance(positions, torch.Tensor):
            raise TypeError("positions must be numpy array, torch tensor, or list")

        # Ensure float32
        if positions.dtype != torch.float32:
            positions = positions.to(torch.float32)

        # Validate shape
        if positions.ndim != 2 or positions.shape[1] != 3:
            raise ValueError(f"positions must be Nx3 array, got shape {positions.shape}")

        n_points = positions.shape[0]

        # Handle heat values
        if heat is None:
            heat = torch.full((n_points,), 0.5, dtype=torch.float32)
        else:
            if isinstance(heat, np.ndarray):
                heat = torch.from_numpy(heat.astype(np.float32))
            elif isinstance(heat, list):
                heat = torch.tensor(heat, dtype=torch.float32)

            # Ensure float32
            if heat.dtype != torch.float32:
                heat = heat.to(torch.float32)

            if heat.shape[0] != n_points:
                raise ValueError(f"heat must have {n_points} values, got {heat.shape[0]}")

        # Handle extra_data
        if extra_data is None:
            extra_data = [{} for _ in range(n_points)]
        else:
            if len(extra_data) != n_points:
                raise ValueError(f"extra_data must have {n_points} entries, got {len(extra_data)}")
            # Validate all are dicts
            if not all(isinstance(d, dict) for d in extra_data):
                raise TypeError("All extra_data entries must be dictionaries")

        # Store internally
        self._positions = positions
        self._heat = heat
        self._extra_data = extra_data

        # Compute heat range
        heat_min_val = float(heat.min().item())
        heat_max_val = float(heat.max().item())

        if self.normalize_heat:
            # Normalize heat to [0, 1]
            if heat_max_val > heat_min_val:
                self._heat = (heat - heat_min_val) / (heat_max_val - heat_min_val)
            else:
                self._heat = torch.zeros_like(heat)

        # Update metadata fields (bypass readonly for internal updates)
        self._values['point_count'] = torch.tensor(n_points, dtype=torch.int32)
        self._values['heat_min'] = torch.tensor(heat_min_val, dtype=torch.float32)
        self._values['heat_max'] = torch.tensor(heat_max_val, dtype=torch.float32)

        # Clear resource ref to indicate it needs export
        self._publish_cloud_ref(None)

    def add_point(
        self,
        position: Union[List[float], np.ndarray, torch.Tensor],
        heat: float = 0.5,
        extra_data: Optional[Dict] = None
    ):
        """Add a single point to the cloud.

        Args:
            position: [x, y, z] coordinates
            heat: Scalar heat value
            extra_data: Optional metadata dictionary
        """
        # Convert position
        if isinstance(position, (list, np.ndarray)):
            position = torch.tensor(position, dtype=torch.float32)

        if position.shape[0] != 3:
            raise ValueError("position must have 3 values [x, y, z]")

        # Initialize if empty
        if self._positions is None:
            self._positions = position.unsqueeze(0)  # Shape: (1, 3)
            self._heat = torch.tensor([heat], dtype=torch.float32)
            self._extra_data = [extra_data or {}]
        else:
            # Append
            self._positions = torch.cat([self._positions, position.unsqueeze(0)], dim=0)
            self._heat = torch.cat([self._heat, torch.tensor([heat], dtype=torch.float32)])
            self._extra_data.append(extra_data or {})

        # Update count (bypass readonly)
        self._values['point_count'] = torch.tensor(self._positions.shape[0], dtype=torch.int32)
        self._publish_cloud_ref(None)  # Mark as needing export

    def remove_point(self, index: int):
        """Remove a point by index."""
        if self._positions is None or index >= self._positions.shape[0]:
            raise IndexError(f"Point index {index} out of range")

        # Create mask
        mask = torch.ones(self._positions.shape[0], dtype=torch.bool)
        mask[index] = False

        # Filter
        self._positions = self._positions[mask]
        self._heat = self._heat[mask]
        self._extra_data = [d for i, d in enumerate(self._extra_data) if i != index]

        # Update count (bypass readonly)
        self._values['point_count'] = torch.tensor(self._positions.shape[0], dtype=torch.int32)
        self._publish_cloud_ref(None)

    def clear_points(self):
        """Remove all points from the cloud."""
        self._positions = None
        self._heat = None
        self._extra_data = None
        # Update count (bypass readonly)
        self._values['point_count'] = torch.tensor(0, dtype=torch.int32)
        self._publish_cloud_ref(None)

    def update_heat(self, index: int, heat: float):
        """Update heat value for a specific point."""
        if self._heat is None or index >= self._heat.shape[0]:
            raise IndexError(f"Point index {index} out of range")

        self._heat[index] = heat
        self._publish_cloud_ref(None)  # Mark as needing re-export

    def update_extra_data(self, index: int, extra_data: Dict):
        """Update extra_data for a specific point."""
        if self._extra_data is None or index >= len(self._extra_data):
            raise IndexError(f"Point index {index} out of range")

        self._extra_data[index] = extra_data
        # Note: extra_data changes don't require re-export (sent separately)

    def _serialize_binary(self) -> bytes:
        """Serialize point cloud to binary format.

        Format:
        - Header (16 bytes):
            - Magic number: "PCLD" (4 bytes)
            - Version: uint32 (4 bytes)
            - Point count: uint32 (4 bytes)
            - Flags: uint32 (4 bytes) - reserved
        - Positions: float32[N, 3] (12*N bytes)
        - Heat: float32[N] (4*N bytes)
        - Extra data: JSON string (variable length)
            - Length prefix: uint32 (4 bytes)
            - JSON data: UTF-8 encoded

        Returns:
            Binary data as bytes
        """
        # Convert to numpy for efficient serialization
        positions_np = self._positions.cpu().numpy().astype(np.float32)
        heat_np = self._heat.cpu().numpy().astype(np.float32)

        # Header
        header = b"PCLD"  # Magic
        header += struct.pack('<I', 1)  # Version
        header += struct.pack('<I', positions_np.shape[0])  # Point count
        header += struct.pack('<I', 0)  # Flags (reserved)

        # Positions and heat (binary)
        positions_bytes = positions_np.tobytes()
        heat_bytes = heat_np.tobytes()

        # Extra data (JSON)
        extra_json = json.dumps(self._extra_data).encode('utf-8')
        extra_len = struct.pack('<I', len(extra_json))

        # Combine
        return header + positions_bytes + heat_bytes + extra_len + extra_json

    def _deserialize_binary(self, data: bytes):
        """Deserialize point cloud from binary format."""
        # Parse header
        magic = data[0:4]
        if magic != b"PCLD":
            raise ValueError("Invalid point cloud data: bad magic number")

        version, point_count, flags = struct.unpack('<III', data[4:16])

        # Parse positions (12 bytes per point)
        offset = 16
        positions_size = point_count * 12
        positions_bytes = data[offset:offset + positions_size]
        positions_np = np.frombuffer(positions_bytes, dtype=np.float32).reshape(point_count, 3)
        offset += positions_size

        # Parse heat (4 bytes per point)
        heat_size = point_count * 4
        heat_bytes = data[offset:offset + heat_size]
        heat_np = np.frombuffer(heat_bytes, dtype=np.float32)
        offset += heat_size

        # Parse extra data
        extra_len = struct.unpack('<I', data[offset:offset + 4])[0]
        offset += 4
        extra_json = data[offset:offset + extra_len].decode('utf-8')
        extra_data = json.loads(extra_json)

        # Set internal data
        self._positions = torch.from_numpy(positions_np)
        self._heat = torch.from_numpy(heat_np)
        self._extra_data = extra_data

        # Update metadata (bypass readonly)
        self._values['point_count'] = torch.tensor(point_count, dtype=torch.int32)

    @button(display_name="Export Point Cloud", description="Export point cloud data to cache")
    def export_point_cloud(self):
        """Export point cloud data to memory cache.

        Returns:
            Status message
        """
        if self._positions is None:
            return "No point cloud data to export. Use set_points() first."

        # Get server
        if not hasattr(self, '_owner') or not self._owner:
            return "Component not attached to scene object"

        scene = getattr(self._owner, 'scene', None)
        if not scene or not hasattr(scene, '_server') or not scene._server:
            return "No server available for export"

        server = scene._server

        # Serialize point cloud data to binary format
        data = self._serialize_binary()

        # Get BinaryAssetHandler from server (handlers is a dict)
        asset_handler = server.handlers.get('binary_assets')
        if not asset_handler:
            return "BinaryAssetHandler not available"

        ref = asset_handler.service.register_bytes(
            kind="point_cloud",
            format=POINT_CLOUD_FORMAT,
            data=data,
            scene_id="default",
            shape=[int(self.point_count)],
            attributes={"point_count": int(self.point_count)},
        )
        self._publish_cloud_ref(ref.to_dict())

        # Calculate size
        size_mb = len(data) / (1024 * 1024)

        # Send success notification
        try:
            from importlib import import_module

            Notifications = import_module(
                "witwin_server.features.notifications.handlers"
            ).NotificationsHandler
            Notifications.success(
                "Point Cloud Cached",
                f"Cached {ref.asset_id} ({self.point_count} points, {size_mb:.2f} MB)"
            )
        except ImportError:
            pass

        return f"Cached point cloud: {ref.asset_id} ({self.point_count} points, {size_mb:.2f} MB)"

    @button(display_name="Random Generation", description="Generate random test point cloud")
    def generate_random_points(self):
        """Generate random point cloud for testing.

        Generates 1000 random points in a sphere with random heat values
        and sample metadata.

        Returns:
            Status message
        """
        # Generate random points in a sphere
        n_points = 1000

        # Spherical coordinates for uniform distribution
        phi = np.random.uniform(0, 2 * np.pi, n_points)
        costheta = np.random.uniform(-1, 1, n_points)
        theta = np.arccos(costheta)
        r = np.random.uniform(0, 3, n_points) ** (1/3)  # Cube root for uniform volume

        # Convert to Cartesian coordinates
        x = r * np.sin(theta) * np.cos(phi)
        y = r * np.sin(theta) * np.sin(phi)
        z = r * np.cos(theta)
        positions = np.stack([x, y, z], axis=1)

        # Generate random heat values
        heat = np.random.rand(n_points)

        # Generate sample metadata
        extra_data = [
            {
                "id": i,
                "label": f"Point_{i}",
                "distance": float(np.linalg.norm(positions[i])),
                "sector": f"S{i % 8}"
            }
            for i in range(n_points)
        ]

        # Set the points
        self.set_points(positions, heat, extra_data)

        # Auto-export after generation
        export_result = self.export_point_cloud()

        # Send info notification
        try:
            from importlib import import_module

            Notifications = import_module(
                "witwin_server.features.notifications.handlers"
            ).NotificationsHandler
            Notifications.info(
                "Random Points Generated",
                f"Generated {n_points} random points in a sphere"
            )
        except ImportError:
            pass

        return f"Generated {n_points} random points. {export_result}"

    def to_dict(self) -> Dict[str, Any]:
        """Serialize component to dictionary.

        Note: Does NOT serialize point data (too large).
        Only serializes metadata. Actual point data is in binary cache.
        """
        result = super().to_dict()

        # Add metadata flags
        if self._positions is not None:
            result['_has_point_data'] = True
            result['_point_shape'] = list(self._positions.shape)
        else:
            result['_has_point_data'] = False

        return result

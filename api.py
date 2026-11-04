"""Public Python API of wt_volume for other Plugins (D16 layer C).

Other Plugins import only this module, and only after listing
``witwin.volume`` in their ``pluginDependencies``. Every other module here
is private and may change without notice. Importing it registers the
``VolumeRenderer`` and ``SDFRenderer`` Components.
"""
from __future__ import annotations

from .components.sdf import SDFRendererComponent
from .components.volume import VolumeRendererComponent

__all__ = ["SDFRendererComponent", "VolumeRendererComponent"]

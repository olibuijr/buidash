"""Author BúiDash's 3D artifacts in Blender and export a single GLB.

Run headless:
    BUIDASH_OUT=public/assets/buidash.glb blender --background --python scripts/build_assets.py

Exports two named meshes the game loads by name (src/game.ts):
  - "player": a beveled neon cube (the GD-style icon)
  - "spike":  a 4-sided neon pyramid

Blender is Z-up; the glTF exporter converts to three.js Y-up automatically.
Both meshes are centred on the origin and 1 unit tall, so placing them at
world-y 0.5 in three.js seats them on the ground (y 0) with the tip at y 1.
"""
import bpy
import math
import os
import addon_utils

OUT = os.environ.get("BUIDASH_OUT", "buidash.glb")
OUT = os.path.abspath(OUT)
os.makedirs(os.path.dirname(OUT), exist_ok=True)

addon_utils.enable("io_scene_gltf2", default_set=True, persistent=True)

# ---- clean slate ----
bpy.ops.wm.read_factory_settings(use_empty=True)


def neon_material(name, base, emit, strength=2.5):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*base, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.28
    bsdf.inputs["Metallic"].default_value = 0.35
    # Emission input names differ across versions — handle both.
    for key in ("Emission Color", "Emission"):
        if key in bsdf.inputs:
            bsdf.inputs[key].default_value = (*emit, 1.0)
            break
    if "Emission Strength" in bsdf.inputs:
        bsdf.inputs["Emission Strength"].default_value = strength
    return mat


# ---- player: beveled neon cube ----
bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, 0, 0))
player = bpy.context.active_object
player.name = "player"
bev = player.modifiers.new("bevel", "BEVEL")
bev.width = 0.09
bev.segments = 3
bpy_bevel = player.modifiers["bevel"]
bpy.ops.object.modifier_apply(modifier="bevel")
player.data.materials.append(neon_material("playerMat", (0.05, 0.62, 0.92), (0.21, 0.88, 1.0), 2.5))

# ---- spike: 4-sided neon pyramid ----
bpy.ops.mesh.primitive_cone_add(vertices=4, radius1=0.5, radius2=0.0, depth=1.0, location=(0, 0, 0))
spike = bpy.context.active_object
spike.name = "spike"
spike.rotation_euler[2] = math.radians(45)
bpy.ops.object.transform_apply(rotation=True, location=False, scale=False)
spike.data.materials.append(neon_material("spikeMat", (1.0, 0.24, 0.65), (1.0, 0.24, 0.65), 2.5))

# ---- export ----
bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.gltf(
    filepath=OUT,
    export_format="GLB",
    use_selection=False,
    export_apply=True,
    export_yup=True,
)
print(f"[buidash] exported {OUT}")
